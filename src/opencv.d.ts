export {};

declare global {
  interface OpenCVMat {
    rows: number;
    cols: number;
    delete: () => void;
    data: Uint8Array;
  }

  interface OpenCVRuntime {
    Mat: new () => OpenCVMat;
    imread: (src: HTMLCanvasElement | HTMLImageElement) => OpenCVMat;
    imshow: (dst: string | HTMLCanvasElement, mat: OpenCVMat) => void;
    cvtColor: (src: OpenCVMat, dst: OpenCVMat, code: number) => void;
    threshold: (
      src: OpenCVMat,
      dst: OpenCVMat,
      thresh: number,
      maxval: number,
      type: number,
    ) => void;
    inpaint: (
      src: OpenCVMat,
      mask: OpenCVMat,
      dst: OpenCVMat,
      inpaintRadius: number,
      flags: number,
    ) => void;
    COLOR_RGBA2RGB: number;
    COLOR_RGBA2GRAY: number;
    COLOR_RGB2RGBA: number;
    INPAINT_TELEA: number;
    INPAINT_NS: number;
    THRESH_BINARY: number;
    onRuntimeInitialized?: () => void;
    getBuildInformation?: () => string;
  }

  var cv: OpenCVRuntime;

  interface Window {
    cv?: OpenCVRuntime;
    Module?: {
      locateFile?: (file: string) => string;
      onRuntimeInitialized?: () => void;
    };
  }
}
