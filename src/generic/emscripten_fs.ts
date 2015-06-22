/**
 * Defines an Emscripten file system object for use in the Emscripten virtual
 * filesystem. Allows you to use synchronous BrowserFS file systems from within
 * Emscripten.
 *
 * You can construct a BFSEmscriptenFS, mount it using its mount command,
 * and then mount it into Emscripten.
 *
 * Adapted from Emscripten's NodeFS:
 * https://raw.github.com/kripken/emscripten/master/src/library_nodefs.js
 */
import BrowserFS = require('../core/browserfs');
import fs = require('../core/node_fs');
//import buffer_core_arraybuffer = require('../core/buffer_core_arraybuffer');
import node_fs_stats = require('../core/node_fs_stats');

export interface Stats {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  timestamp?: number;
}

export interface EmscriptenFSNode {
  name: string;
  mode: number;
  parent: EmscriptenFSNode;
  mount: {opts: {root: string}};
  stream_ops: EmscriptenStreamOps;
  node_ops: EmscriptenNodeOps;
}

export interface EmscriptenStream {
  node: EmscriptenFSNode;
  nfd: any;
  flags: string;
  position: number;
}

export interface EmscriptenNodeOps {
  getattr(node: EmscriptenFSNode): Stats;
  setattr(node: EmscriptenFSNode, attr: Stats): void;
  lookup(parent: EmscriptenFSNode, name: string): EmscriptenFSNode;
  mknod(parent: EmscriptenFSNode, name: string, mode: number, dev: any): EmscriptenFSNode;
  rename(oldNode: EmscriptenFSNode, newDir: EmscriptenFSNode, newName: string): void;
  unlink(parent: EmscriptenFSNode, name: string): void;
  rmdir(parent: EmscriptenFSNode, name: string): void;
  readdir(node: EmscriptenFSNode): string[];
  symlink(parent: EmscriptenFSNode, newName: string, oldPath: string): void;
  readlink(node: EmscriptenFSNode): string;
}

export interface EmscriptenStreamOps {
  open(stream: EmscriptenStream): void;
  close(stream: EmscriptenStream): void;
  read(stream: EmscriptenStream, buffer: Uint8Array, offset: number, length: number, position: number): number;
  write(stream: EmscriptenStream, buffer: Uint8Array, offset: number, length: number, position: number): number;
  llseek(stream: EmscriptenStream, offset: number, whence: number): number;
}

export interface EmscriptenFS {
  mount(mount: {opts: {root: string}}): EmscriptenFSNode;
  createNode(parent: EmscriptenFSNode, name: string, mode: number, dev?: any): EmscriptenFSNode;
  getMode(path: string): number;
  realPath(node: EmscriptenFSNode): string;
  node_ops: EmscriptenNodeOps;
  stream_ops: EmscriptenStreamOps;
}

class BFSEmscriptenStreamOps implements EmscriptenStreamOps {
  private FS: any;
  private PATH: any;
  private ERRNO_CODES: any;

  constructor(private fs: BFSEmscriptenFS) {
    this.FS = fs.getFS();
    this.PATH = fs.getPATH();
    this.ERRNO_CODES = fs.getERRNO_CODES();
  }

  public open(stream: EmscriptenStream): void {
    var path = this.fs.realPath(stream.node),
      FS = this.FS;
    try {
      if (FS.isFile(stream.node.mode)) {
        stream.nfd = fs.openSync(path, this.fs.flagsToPermissionString(stream.flags));
      }
    } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(this.ERRNO_CODES[e.code]);
    }
  }

  public close(stream: EmscriptenStream): void {
    var FS = this.FS;
    try {
      if (FS.isFile(stream.node.mode) && stream.nfd) {
        fs.closeSync(stream.nfd);
      }
    } catch (e) {
      if (!e.code) throw e;
      throw new FS.ErrnoError(this.ERRNO_CODES[e.code]);
    }
  }

  public read(stream: EmscriptenStream, buffer: Uint8Array, offset: number, length: number, position: number): number {
    // Avoid copying overhead by reading directly into buffer.
    //var bcore = new BufferCoreArrayBuffer(buffer.buffer);
    var nbuffer = new Buffer(buffer);
    var res: number;
    try {
      res = fs.readSync(stream.nfd, nbuffer, 0, length, position);
    } catch (e) {
      throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
    }
    // No copying needed, since we wrote directly into UintArray.
    return res;
  }

  public write(stream: EmscriptenStream, buffer: Uint8Array, offset: number, length: number, position: number): number {
    // Avoid copying overhead; plug the buffer directly into a BufferCore.
    //var bcore = new BufferCoreArrayBuffer(buffer.buffer);
    var nbuffer = new Buffer(buffer);
    var res: number;
    try {
      res = fs.writeSync(stream.nfd, nbuffer, 0, length, position);
    } catch (e) {
      throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
    }
    return res;
  }

  public llseek(stream: EmscriptenStream, offset: number, whence: number): number {
    var position = offset;
    if (whence === 1) {  // SEEK_CUR.
      position += stream.position;
    } else if (whence === 2) {  // SEEK_END.
      if (this.FS.isFile(stream.node.mode)) {
        try {
          var stat = fs.fstatSync(stream.nfd);
          position += stat.size;
        } catch (e) {
          throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
        }
      }
    }

    if (position < 0) {
      throw new this.FS.ErrnoError(this.ERRNO_CODES.EINVAL);
    }

    stream.position = position;
    return position;
  }
}

class BFSEmscriptenNodeOps implements EmscriptenNodeOps {
  private FS: any;
  private PATH: any;
  private ERRNO_CODES: any;

  constructor(private fs: BFSEmscriptenFS) {
    this.FS = fs.getFS();
    this.PATH = fs.getPATH();
    this.ERRNO_CODES = fs.getERRNO_CODES();
  }

  public getattr(node: EmscriptenFSNode): Stats {
    var path = this.fs.realPath(node);
    var stat: node_fs_stats.Stats;
    try {
      stat = fs.lstatSync(path);
    } catch (e) {
      if (!e.code) throw e;
      throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
    }
    return <Stats>{
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      nlink: stat.nlink,
      uid: stat.uid,
      gid: stat.gid,
      rdev: stat.rdev,
      size: stat.size,
      atime: stat.atime,
      mtime: stat.mtime,
      ctime: stat.ctime,
      blksize: stat.blksize,
      blocks: stat.blocks
    };
  }

  public setattr(node: EmscriptenFSNode, attr: Stats): void {
    var path = this.fs.realPath(node);
    try {
      if (attr.mode !== undefined) {
        fs.chmodSync(path, attr.mode);
        // update the common node structure mode as well
        node.mode = attr.mode;
      }
      if (attr.timestamp !== undefined) {
        var date = new Date(attr.timestamp);
        fs.utimesSync(path, date, date);
      }
    } catch (e) {
      if (!e.code) throw e;
      // Ignore not supported errors. Emscripten does utimesSync when it
      // writes files, but never really requires the value to be set.
      if (e.code !== "ENOTSUP") {
        throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
      }
    }
    if (attr.size !== undefined) {
      try {
        fs.truncateSync(path, attr.size);
      } catch (e) {
        if (!e.code) throw e;
        throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
      }
    }
  }

  public lookup(parent: EmscriptenFSNode, name: string): EmscriptenFSNode {
    var path = this.PATH.join2(this.fs.realPath(parent), name);
    var mode = this.fs.getMode(path);
    return this.fs.createNode(parent, name, mode);
  }

  public mknod(parent: EmscriptenFSNode, name: string, mode: number, dev: any): EmscriptenFSNode {
    var node = this.fs.createNode(parent, name, mode, dev);
    // create the backing node for this in the fs root as well
    var path = this.fs.realPath(node);
    try {
      if (this.FS.isDir(node.mode)) {
        fs.mkdirSync(path, node.mode);
      } else {
        fs.writeFileSync(path, '', { mode: node.mode });
      }
    } catch (e) {
      if (!e.code) throw e;
      throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
    }
    return node;
  }

  public rename(oldNode: EmscriptenFSNode, newDir: EmscriptenFSNode, newName: string): void {
    var oldPath = this.fs.realPath(oldNode);
    var newPath = this.PATH.join2(this.fs.realPath(newDir), newName);
    try {
      fs.renameSync(oldPath, newPath);
    } catch (e) {
      if (!e.code) throw e;
      throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
    }
  }

  public unlink(parent: EmscriptenFSNode, name: string): void {
    var path = this.PATH.join2(this.fs.realPath(parent), name);
    try {
      fs.unlinkSync(path);
    } catch (e) {
      if (!e.code) throw e;
      throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
    }
  }

  public rmdir(parent: EmscriptenFSNode, name: string) {
    var path = this.PATH.join2(this.fs.realPath(parent), name);
    try {
      fs.rmdirSync(path);
    } catch (e) {
      if (!e.code) throw e;
      throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
    }
  }

  public readdir(node: EmscriptenFSNode): string[] {
    var path = this.fs.realPath(node);
    try {
      return fs.readdirSync(path);
    } catch (e) {
      if (!e.code) throw e;
      throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
    }
  }

  public symlink(parent: EmscriptenFSNode, newName: string, oldPath: string): void {
    var newPath = this.PATH.join2(this.fs.realPath(parent), newName);
    try {
      fs.symlinkSync(oldPath, newPath);
    } catch (e) {
      if (!e.code) throw e;
      throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
    }
  }

  public readlink(node: EmscriptenFSNode): string {
    var path = this.fs.realPath(node);
    try {
      return fs.readlinkSync(path);
    } catch (e) {
      if (!e.code) throw e;
      throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
    }
  }
}

export class BFSEmscriptenFS implements EmscriptenFS {
  private FS: any;
  private PATH: any;
  private ERRNO_CODES: any;
  constructor(_FS = (<any> self)['FS'], _PATH = (<any> self)['PATH'], _ERRNO_CODES = (<any> self)['ERRNO_CODES']) {
    if (typeof BrowserFS === 'undefined') {
      throw new Error("BrowserFS is not loaded. Please load it before this library.");
    }
    this.FS = _FS;
    this.PATH = _PATH;
    this.ERRNO_CODES = _ERRNO_CODES;
    this.node_ops = new BFSEmscriptenNodeOps(this);
    this.stream_ops = new BFSEmscriptenStreamOps(this);
  }

  public mount(mount: {opts: {root: string}}): EmscriptenFSNode {
    return this.createNode(null, '/', this.getMode(mount.opts.root), 0);
  }

  public createNode(parent: EmscriptenFSNode, name: string, mode: number, dev?: any): EmscriptenFSNode {
    var FS = this.FS;
    if (!FS.isDir(mode) && !FS.isFile(mode) && !FS.isLink(mode)) {
      throw new FS.ErrnoError(this.ERRNO_CODES.EINVAL);
    }
    var node = FS.createNode(parent, name, mode);
    node.node_ops = this.node_ops;
    node.stream_ops = this.stream_ops;
    return node;
  }

  public getMode(path: string): number {
    var stat: node_fs_stats.Stats;
    try {
      stat = fs.lstatSync(path);
    } catch (e) {
      if (!e.code) throw e;
      throw new this.FS.ErrnoError(this.ERRNO_CODES[e.code]);
    }
    return stat.mode;
  }

  public realPath(node: EmscriptenFSNode): string {
    var parts: string[] = [];
    while (node.parent !== node) {
      parts.push(node.name);
      node = node.parent;
    }
    parts.push(node.mount.opts.root);
    parts.reverse();
    return this.PATH.join.apply(null, parts);
  }
  // This maps the integer permission modes from http://linux.die.net/man/3/open
  // to node.js-specific file open permission strings at http://nodejs.org/api/fs.html#fs_fs_open_path_flags_mode_callback
  public flagsToPermissionStringMap = {
    0/*O_RDONLY*/: 'r',
    1/*O_WRONLY*/: 'r+',
    2/*O_RDWR*/: 'r+',
    64/*O_CREAT*/: 'r',
    65/*O_WRONLY|O_CREAT*/: 'r+',
    66/*O_RDWR|O_CREAT*/: 'r+',
    129/*O_WRONLY|O_EXCL*/: 'rx+',
    193/*O_WRONLY|O_CREAT|O_EXCL*/: 'rx+',
    514/*O_RDWR|O_TRUNC*/: 'w+',
    577/*O_WRONLY|O_CREAT|O_TRUNC*/: 'w',
    578/*O_CREAT|O_RDWR|O_TRUNC*/: 'w+',
    705/*O_WRONLY|O_CREAT|O_EXCL|O_TRUNC*/: 'wx',
    706/*O_RDWR|O_CREAT|O_EXCL|O_TRUNC*/: 'wx+',
    1024/*O_APPEND*/: 'a',
    1025/*O_WRONLY|O_APPEND*/: 'a',
    1026/*O_RDWR|O_APPEND*/: 'a+',
    1089/*O_WRONLY|O_CREAT|O_APPEND*/: 'a',
    1090/*O_RDWR|O_CREAT|O_APPEND*/: 'a+',
    1153/*O_WRONLY|O_EXCL|O_APPEND*/: 'ax',
    1154/*O_RDWR|O_EXCL|O_APPEND*/: 'ax+',
    1217/*O_WRONLY|O_CREAT|O_EXCL|O_APPEND*/: 'ax',
    1218/*O_RDWR|O_CREAT|O_EXCL|O_APPEND*/: 'ax+',
    4096/*O_RDONLY|O_DSYNC*/: 'rs',
    4098/*O_RDWR|O_DSYNC*/: 'rs+'
  }

  public flagsToPermissionString(flags: string): string {
    if (flags in this.flagsToPermissionStringMap) {
      return (<any> this.flagsToPermissionStringMap)[flags];
    } else {
      return flags;
    }
  }

  public getFS() {
    return this.FS;
  }

  public getPATH() {
    return this.PATH;
  }

  public getERRNO_CODES() {
    return this.ERRNO_CODES;
  }

  public node_ops: EmscriptenNodeOps;
  public stream_ops: EmscriptenStreamOps;
}

// Make it available on the global BrowserFS object.
(<any> BrowserFS)['EmscriptenFS'] = BFSEmscriptenFS;
