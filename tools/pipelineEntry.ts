export { detectUnwantedOverlay } from "../src/utils/watermarkDetector";
export { nearestNeighborFill } from "../src/utils/nearestNeighborFill";
export { exemplarFill } from "../src/utils/exemplarFill";
export { inpaintTeleaJs } from "../src/utils/inpaintFallback";
export {
  analyzeMask,
  compositeMaskedPixels,
  countChangedPixels,
  verifyOutsideMaskUnchanged,
  paddedCropRect,
  CROP_PADDING,
} from "../src/utils/maskStats";
