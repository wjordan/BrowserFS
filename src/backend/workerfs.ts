import file_system = require('../core/file_system');
import api_error = require('../core/api_error');
import file_flag = require('../core/file_flag');
import util = require('../core/util');
import file = require('../core/file');
import node_fs_stats = require('../core/node_fs_stats');
import preload_file = require('../generic/preload_file');
import browserfs = require('../core/browserfs');

interface IBrowserFSMessage {
  browserfsMessage: boolean;
}

enum SpecialArgType {
  // Callback
  CB,
  // File descriptor
  FD,
  // API error
  ERROR,
  // Stats object
  STATS,
  // Initial probe for file system information.
  PROBE,
  // FileFlag object.
  FILEFLAG,
  // Buffer object.
  BUFFER
}

interface ISpecialArgument {
  type: SpecialArgType;
}

interface IProbeResponse extends ISpecialArgument {
  isReadOnly: boolean;
  supportsLinks: boolean;
  supportsProps: boolean;
}

interface ICallbackArgument extends ISpecialArgument {
  // The callback ID.
  id: number;
}

/**
 * Converts callback arguments into ICallbackArgument objects, and back
 * again.
 */
class CallbackArgumentConverter {
  private _callbacks: { [id: number]: Function } = {};
  private _nextId: number = 0;

  public toRemoteArg(cb: Function): ICallbackArgument {
    var id = this._nextId++;
    this._callbacks[id] = cb;
    return {
      type: SpecialArgType.CB,
      id: id
    };
  }

  public toLocalArg(id: number): Function {
    var cb = this._callbacks[id];
    delete this._callbacks[id];
    return cb;
  }
}

interface IFileDescriptorArgument extends ISpecialArgument {
  // The file descriptor's id on the remote side.
  id: number;
  // The entire file's data, as an array buffer.
  data: ArrayBuffer;
  // The file's stat object, as an array buffer.
  stat: ArrayBuffer;
  // The path to the file.
  path: string;
  // The flag of the open file descriptor.
  flag: string;
}

class FileDescriptorArgumentConverter {
  private _fileDescriptors: { [id: number]: file.File } = {};
  private _nextId: number = 0;

  public toRemoteArg(fd: file.File, p: string, flag: file_flag.FileFlag, cb: (err: api_error.ApiError, arg?: IFileDescriptorArgument) => void): void {
    var id = this._nextId++,
      data: ArrayBuffer,
      stat: ArrayBuffer,
      argsLeft: number = 2;
    this._fileDescriptors[id] = fd;

    // Extract needed information asynchronously.
    fd.stat((err, stats) => {
      if (err) {
        cb(err);
      } else {
        stat = (<any> stats.toBuffer()).toArrayBuffer();
        // If it's a readable flag, we need to grab contents.
        if (flag.isReadable()) {
          fd.read(new Buffer(stats.size), 0, stats.size, 0, (err, bytesRead, buff) => {
            if (err) {
              cb(err);
            } else {
              data = (<any> buff).toArrayBuffer();
              cb(null, {
                type: SpecialArgType.FD,
                id: id,
                data: data,
                stat: stat,
                path: p,
                flag: flag.getFlagString()
              });
            }
          });
        } else {
          // File is not readable, which means writing to it will append or
          // truncate/replace existing contents. Return an empty arraybuffer.
          cb(null, {
            type: SpecialArgType.FD,
            id: id,
            data: new ArrayBuffer(0),
            stat: stat,
            path: p,
            flag: flag.getFlagString()
          });
        }
      }
    });
  }

  private _applyFdChanges(remoteFd: IFileDescriptorArgument, cb: (err: api_error.ApiError, fd?: file.File) => void): void {
    var fd = this._fileDescriptors[remoteFd.id],
      data = new Buffer(<any>remoteFd.data),
      remoteStats = node_fs_stats.Stats.fromBuffer(new Buffer(<any>remoteFd.stat));

    // Write data if the file is writable.
    var flag = file_flag.FileFlag.getFileFlag(remoteFd.flag);
    if (flag.isWriteable()) {
      // Appendable: Write to end of file.
      // Writeable: Replace entire contents of file.
      fd.write(data, 0, data.length, flag.isAppendable() ? fd.getPos() : 0, (e) => {
        if (e) {
          cb(e);
        } else {
          function applyStatChanges() {
            // Check if mode changed.
            fd.stat((e, stats?) => {
              if (e) {
                cb(e);
              } else {
                if (stats.mode !== remoteStats.mode) {
                  fd.chmod(remoteStats.mode, (e: any) => {
                    cb(e, fd);
                  });
                } else {
                  cb(e, fd);
                }
              }
            });
          }

          // If writeable & not appendable, we need to ensure file contents are
          // identical to those from the remote FD. Thus, we truncate to the
          // length of the remote file.
          if (!flag.isAppendable()) {
            fd.truncate(data.length, () => {
              applyStatChanges();
            })
          } else {
            applyStatChanges();
          }
        }
      });
    } else {
      cb(null, fd);
    }
  }

  public applyFdAPIRequest(request: IAPIRequest, cb: (err?: api_error.ApiError) => void): void {
    var fdArg = <IFileDescriptorArgument> request.args[0];
    this._applyFdChanges(fdArg, (err, fd?) => {
      if (err) {
        cb(err);
      } else {
        // Apply method on now-changed file descriptor.
        (<any> fd)[request.method]((e?: api_error.ApiError) => {
          if (request.method === 'close') {
            delete this._fileDescriptors[fdArg.id];
          }
          cb(e);
        });
      }
    });
  }
}

interface IErrorArgument extends ISpecialArgument {
  // The error object, as an array buffer.
  errorData: ArrayBuffer;
}

function errorLocal2Remote(e: api_error.ApiError): IErrorArgument {
  return {
    type: SpecialArgType.ERROR,
    errorData: (<any> e.writeToBuffer()).toArrayBuffer()
  };
}

function errorRemote2Local(e: IErrorArgument): api_error.ApiError {
  return api_error.ApiError.fromBuffer(new Buffer(<any>e.errorData));
}

interface IStatsArgument extends ISpecialArgument {
  // The stats object as an array buffer.
  statsData: ArrayBuffer;
}

function statsLocal2Remote(stats: node_fs_stats.Stats): IStatsArgument {
  return {
    type: SpecialArgType.STATS,
    statsData: (<any> stats.toBuffer()).toArrayBuffer()
  };
}

function statsRemote2Local(stats: IStatsArgument): node_fs_stats.Stats {
  return node_fs_stats.Stats.fromBuffer(new Buffer(<any>stats.statsData));
}

interface IFileFlagArgument extends ISpecialArgument {
  flagStr: string;
}

function fileFlagLocal2Remote(flag: file_flag.FileFlag): IFileFlagArgument {
  return {
    type: SpecialArgType.FILEFLAG,
    flagStr: flag.getFlagString()
  };
}

function fileFlagRemote2Local(remoteFlag: IFileFlagArgument): file_flag.FileFlag {
  return file_flag.FileFlag.getFileFlag(remoteFlag.flagStr);
}

interface IBufferArgument extends ISpecialArgument {
  data: ArrayBuffer;
}

function bufferLocal2Remote(buff: Buffer): IBufferArgument {
  return {
    type: SpecialArgType.BUFFER,
    data: (<any> buff).toArrayBuffer()
  };
}

function bufferRemote2Local(buffArg: IBufferArgument): Buffer {
  return new Buffer(<any>buffArg.data);
}

interface IAPIRequest extends IBrowserFSMessage {
  method: string;
  args: Array<number | string | ISpecialArgument>;
}

interface IAPIResponse extends IBrowserFSMessage {
  cbId: number;
  args: Array<number | string | ISpecialArgument>;
}

/**
 * Represents a remote file in a different worker/thread.
 */
class WorkerFile extends preload_file.PreloadFile {
  private _remoteFdId: number;

  constructor(_fs: WorkerFS, _path: string, _flag: file_flag.FileFlag, _stat: node_fs_stats.Stats, remoteFdId: number, contents?: NodeBuffer) {
    super(_fs, _path, _flag, _stat, contents);
    this._remoteFdId = remoteFdId;
  }

  public getRemoteFdId() {
    return this._remoteFdId;
  }

  public toRemoteArg(): IFileDescriptorArgument {
    return {
      type: SpecialArgType.FD,
      id: this._remoteFdId,
      data: (<any> this.getBuffer()).toArrayBuffer(),
      stat: (<any> this.getStats().toBuffer()).toArrayBuffer(),
      path: this.getPath(),
      flag: this.getFlag().getFlagString()
    };
  }
  
  private _syncClose(type: string, cb: (e?: api_error.ApiError) => void): void {
    if (this.isDirty()) {
      (<WorkerFS> this._fs).syncClose(type, this, (e?: api_error.ApiError) => {
        if (!e) {
          this.resetDirty();
        }
        cb(e);
      });
    } else {
      cb();
    }
  }

  public sync(cb: (e?: api_error.ApiError) => void): void {
    this._syncClose('sync', cb);
  }

  public close(cb: (e?: api_error.ApiError) => void): void {
    this._syncClose('close', cb);
  }
}

/**
 * WorkerFS lets you access a BrowserFS instance that is running in a different
 * JavaScript context (e.g. access BrowserFS in one of your WebWorkers, or
 * access BrowserFS running on the main page from a WebWorker).
 *
 * For example, to have a WebWorker access files in the main browser thread,
 * do the following:
 *
 * MAIN BROWSER THREAD:
 * ```
 *   // Listen for remote file system requests.
 *   BrowserFS.FileSystem.WorkerFS.attachRemoteListener(webWorkerObject);
 * ``
 *
 * WEBWORKER THREAD:
 * ```
 *   // Set the remote file system as the root file system.
 *   BrowserFS.initialize(new BrowserFS.FileSystem.WorkerFS(self));
 * ```
 *
 * Note that synchronous operations are not permitted on the WorkerFS, regardless
 * of the configuration option of the remote FS.
 */
export class WorkerFS extends file_system.BaseFileSystem implements file_system.FileSystem {
  private _worker: Worker;
  private _callbackConverter = new CallbackArgumentConverter();

  private _isInitialized: boolean = false;
  private _isReadOnly: boolean = false;
  private _supportLinks: boolean = false;
  private _supportProps: boolean = false;

  /**
   * Stores outstanding API requests to the remote BrowserFS instance.
   */
  private _outstandingRequests: { [id: number]: () => void } = {};

  /**
   * Constructs a new WorkerFS instance that connects with BrowserFS running on
   * the specified worker.
   */
  constructor(worker: Worker) {
    super();
    this._worker = worker;
    this._worker.addEventListener('message',(e: MessageEvent) => {
      if (e.data != null && typeof e.data === 'object' && e.data.hasOwnProperty('browserfsMessage') && e.data['browserfsMessage']) {
        var resp: IAPIResponse = e.data, i: number, args = resp.args, fixedArgs = new Array(args.length);
        // Dispatch event to correct id.
        for (i = 0; i < fixedArgs.length; i++) {
          fixedArgs[i] = this._argRemote2Local(args[i]);
        }
        this._callbackConverter.toLocalArg(resp.cbId).apply(null, fixedArgs);
      }
    });
  }

  public static isAvailable(): boolean {
    return typeof Worker !== 'undefined';
  }

  public getName(): string {
    return 'WorkerFS';
  }

  private _argRemote2Local(arg: any): any {
    if (arg == null) {
      return arg;
    }
    switch (typeof arg) {
      case 'object':
        if (arg['type'] != null && typeof arg['type'] === 'number') {
          var specialArg = <ISpecialArgument> arg;
          switch (specialArg.type) {
            case SpecialArgType.ERROR:
              return errorRemote2Local(<IErrorArgument> specialArg);
            case SpecialArgType.FD:
              var fdArg = <IFileDescriptorArgument> specialArg;
              return new WorkerFile(this, fdArg.path, file_flag.FileFlag.getFileFlag(fdArg.flag), node_fs_stats.Stats.fromBuffer(new Buffer(<any>fdArg.stat)), fdArg.id, new Buffer(<any>fdArg.data));
            case SpecialArgType.STATS:
              return statsRemote2Local(<IStatsArgument> specialArg);
            case SpecialArgType.FILEFLAG:
              return fileFlagRemote2Local(<IFileFlagArgument> specialArg);
            case SpecialArgType.BUFFER:
              return bufferRemote2Local(<IBufferArgument> specialArg);
            default:
              return arg;
          }
        } else {
          return arg;
        }
      default:
        return arg;
    }
  }

  private _argLocal2Remote(arg: any): any {
    if (arg == null) {
      return arg;
    }
    switch (typeof arg) {
      case "object":
        if (arg instanceof node_fs_stats.Stats) {
          return statsLocal2Remote(arg);
        } else if (arg instanceof api_error.ApiError) {
          return errorLocal2Remote(arg);
        } else if (arg instanceof WorkerFile) {
          return (<WorkerFile> arg).toRemoteArg();
        } else if (arg instanceof file_flag.FileFlag) {
          return fileFlagLocal2Remote(arg);
        } else if (arg instanceof Buffer) {
          return bufferLocal2Remote(arg);
        } else {
          return arg;
        }
      case "function":
        return this._callbackConverter.toRemoteArg(arg);
      default:
        return arg;
    }
  }

  /**
   * Called once both local and remote sides are set up.
   */
  public initialize(cb: () => void): void {
    if (!this._isInitialized) {
      var message: IAPIRequest = {
        browserfsMessage: true,
        method: 'probe',
        args: [this._callbackConverter.toRemoteArg((probeResponse: IProbeResponse) => {
          this._isInitialized = true;
          this._isReadOnly = probeResponse.isReadOnly;
          this._supportLinks = probeResponse.supportsLinks;
          this._supportProps = probeResponse.supportsProps;
          cb();
        })]
      };
      this._worker.postMessage(message);
    } else {
      cb();
    }
  }

  public isReadOnly(): boolean { return this._isReadOnly; }
  public supportsSynch(): boolean { return false; }
  public supportsLinks(): boolean { return this._supportLinks; }
  public supportsProps(): boolean { return this._supportProps; }

  private _rpc(methodName: string, args: IArguments) {
    var message: IAPIRequest = {
      browserfsMessage: true,
      method: methodName,
      args: null
    }, fixedArgs = new Array(args.length), i: number;
    for (i = 0; i < args.length; i++) {
      fixedArgs[i] = this._argLocal2Remote(args[i]);
    }
    message.args = fixedArgs;
    this._worker.postMessage(message);
  }

  public rename(oldPath: string, newPath: string, cb: (err?: api_error.ApiError) => void): void {
    this._rpc('rename', arguments);
  }
  public stat(p: string, isLstat: boolean, cb: (err: api_error.ApiError, stat?: node_fs_stats.Stats) => void): void {
    this._rpc('stat', arguments);
  }
  public open(p: string, flag: file_flag.FileFlag, mode: number, cb: (err: api_error.ApiError, fd?: file.File) => any): void {
    this._rpc('open', arguments);
  }
  public unlink(p: string, cb: Function): void {
    this._rpc('unlink', arguments);
  }
  public rmdir(p: string, cb: Function): void {
    this._rpc('rmdir', arguments);
  }
  public mkdir(p: string, mode: number, cb: Function): void {
    this._rpc('mkdir', arguments);
  }
  public readdir(p: string, cb: (err: api_error.ApiError, files?: string[]) => void): void {
    this._rpc('readdir', arguments);
  }
  public exists(p: string, cb: (exists: boolean) => void): void {
    this._rpc('exists', arguments);
  }
  public realpath(p: string, cache: { [path: string]: string }, cb: (err: api_error.ApiError, resolvedPath?: string) => any): void {
    this._rpc('realpath', arguments);
  }
  public truncate(p: string, len: number, cb: Function): void {
    this._rpc('truncate', arguments);
  }
  public readFile(fname: string, encoding: string, flag: file_flag.FileFlag, cb: (err: api_error.ApiError, data?: any) => void): void {
    this._rpc('readFile', arguments);
  }
  public writeFile(fname: string, data: any, encoding: string, flag: file_flag.FileFlag, mode: number, cb: (err: api_error.ApiError) => void): void {
    this._rpc('writeFile', arguments);
  }
  public appendFile(fname: string, data: any, encoding: string, flag: file_flag.FileFlag, mode: number, cb: (err: api_error.ApiError) => void): void {
    this._rpc('appendFile', arguments);
  }
  public chmod(p: string, isLchmod: boolean, mode: number, cb: Function): void {
    this._rpc('chmod', arguments);
  }
  public chown(p: string, isLchown: boolean, uid: number, gid: number, cb: Function): void {
    this._rpc('chown', arguments);
  }
  public utimes(p: string, atime: Date, mtime: Date, cb: Function): void {
    this._rpc('utimes', arguments);
  }
  public link(srcpath: string, dstpath: string, cb: Function): void {
    this._rpc('link', arguments);
  }
  public symlink(srcpath: string, dstpath: string, type: string, cb: Function): void {
    this._rpc('symlink', arguments);
  }
  public readlink(p: string, cb: Function): void {
    this._rpc('readlink', arguments);
  }

  public syncClose(method: string, fd: file.File, cb: (e: api_error.ApiError) => void): void {
    this._worker.postMessage(<IAPIRequest> {
      browserfsMessage: true,
      method: method,
      args: [(<WorkerFile> fd).toRemoteArg(), this._callbackConverter.toRemoteArg(cb)]
    });
  }

  /**
   * Attaches a listener to the remote worker for file system requests.
   */
  public static attachRemoteListener(worker: Worker) {
    var fdConverter = new FileDescriptorArgumentConverter(),
      fs = browserfs.BFSRequire('fs');

    function argLocal2Remote(arg: any, requestArgs: any[], cb: (err: api_error.ApiError, arg?: any) => void): void {
      switch (typeof arg) {
        case 'object':
          if (arg instanceof node_fs_stats.Stats) {
            cb(null, statsLocal2Remote(arg));
          } else if (arg instanceof api_error.ApiError) {
            cb(null, errorLocal2Remote(arg));
          } else if (arg instanceof file.BaseFile) {
            // Pass in p and flags from original request.
            cb(null, fdConverter.toRemoteArg(arg, requestArgs[0], requestArgs[1], cb));
          } else if (arg instanceof file_flag.FileFlag) {
            cb(null, fileFlagLocal2Remote(arg));
          } else if (arg instanceof Buffer) {
            cb(null, bufferLocal2Remote(arg));
          } else {
            cb(null, arg);
          }
          break;
        default:
          cb(null, arg);
          break;
      }
    }

    function argRemote2Local(arg: any, fixedRequestArgs: any[]): any {
      if (arg == null) {
        return arg;
      }
      switch (typeof arg) {
        case 'object':
          if (typeof arg['type'] === 'number') {
            var specialArg = <ISpecialArgument> arg;
            switch (specialArg.type) {
              case SpecialArgType.CB:
                var cbId = (<ICallbackArgument> arg).id;
                return function() {
                  var i: number, fixedArgs = new Array(arguments.length),
                    message: IAPIResponse,
                    countdown = arguments.length;

                  function abortAndSendError(err: api_error.ApiError) {
                    if (countdown > 0) {
                      countdown = -1;
                      message = {
                        browserfsMessage: true,
                        cbId: cbId,
                        args: [errorLocal2Remote(err)]
                      };
                      worker.postMessage(message);
                    }
                  }


                  for (i = 0; i < arguments.length; i++) {
                    // Capture i and argument.
                    ((i: number, arg: any) => {
                      argLocal2Remote(arg, fixedRequestArgs, (err, fixedArg?) => {
                        fixedArgs[i] = fixedArg;
                        if (err) {
                          abortAndSendError(err);
                        } else if (--countdown === 0) {
                          message = {
                            browserfsMessage: true,
                            cbId: cbId,
                            args: fixedArgs
                          };
                          worker.postMessage(message);
                        }
                      });
                    })(i, arguments[i]);
                  }

                  if (arguments.length === 0) {
                    message = {
                      browserfsMessage: true,
                      cbId: cbId,
                      args: fixedArgs
                    };
                    worker.postMessage(message);
                  }

                };
              case SpecialArgType.ERROR:
                return errorRemote2Local(<IErrorArgument> specialArg);
              case SpecialArgType.STATS:
                return statsRemote2Local(<IStatsArgument> specialArg);
              case SpecialArgType.FILEFLAG:
                return fileFlagRemote2Local(<IFileFlagArgument> specialArg);
              case SpecialArgType.BUFFER:
                return bufferRemote2Local(<IBufferArgument> specialArg);
              default:
                // No idea what this is.
                return arg;
            }
          } else {
            return arg;
          }
        default:
          return arg;
      }
    }

    worker.addEventListener('message',(e: MessageEvent) => {
      if (e.data != null && typeof e.data === 'object' && e.data.hasOwnProperty('browserfsMessage') && e.data['browserfsMessage']) {
        var request: IAPIRequest = e.data,
          args = request.args,
          fixedArgs = new Array<any>(args.length),
          i: number;

        switch (request.method) {
          case 'close':
          case 'sync':
            (() => {
              // File descriptor-relative methods.
              var remoteCb = <ICallbackArgument> args[1];
              fdConverter.applyFdAPIRequest(request, (err?: api_error.ApiError) => {
                // Send response.
                var response: IAPIResponse = {
                  browserfsMessage: true,
                  cbId: remoteCb.id,
                  args: err ? [errorLocal2Remote(err)] : []
                };
                worker.postMessage(response);
              });
            })();
            break;
          case 'probe':
            (() => {
              var rootFs = <file_system.FileSystem> fs.getRootFS(),
                remoteCb = <ICallbackArgument> args[0],
                response: IAPIResponse = {
                  browserfsMessage: true,
                  cbId: remoteCb.id,
                  args: [<IProbeResponse> {
                    type: SpecialArgType.PROBE,
                    isReadOnly: rootFs.isReadOnly(),
                    supportsLinks: rootFs.supportsLinks(),
                    supportsProps: rootFs.supportsProps()
                  }]
                };
              worker.postMessage(response);
            })();
            break;
          default:
            // File system methods.
            for (i = 0; i < args.length; i++) {
              fixedArgs[i] = argRemote2Local(args[i], fixedArgs);
            }
            var rootFS = fs.getRootFS();
            (<Function> rootFS[request.method]).apply(rootFS, fixedArgs);
            break;
        }
      }
    });
  }
}

browserfs.registerFileSystem('WorkerFS', WorkerFS);
