declare module 'mp4box' {
  export interface MP4ArrayBuffer extends ArrayBuffer {
    fileStart: number;
  }
  export function createFile(): {
    onReady?: (info: any) => void;
    onError?: (err: any) => void;
    appendBuffer: (buf: MP4ArrayBuffer) => number;
    flush: () => void;
  };
}
