export { detectUnwantedOverlay } from "../src/utils/watermarkDetector";
export { findSparkleMark, debugSparkleAt, debugSparkleHits } from "../src/utils/sparkleMark";
export { nearestNeighborFill } from "../src/utils/nearestNeighborFill";
export { exemplarFill } from "../src/utils/exemplarFill";
export { hybridFill } from "../src/utils/hybridFill";
export { inpaintTeleaJs } from "../src/utils/inpaintFallback";
export {
  analyzeMask,
  compositeMaskedPixels,
  countChangedPixels,
  verifyOutsideMaskUnchanged,
  paddedCropRect,
  surroundingSpread,
  CROP_PADDING,
} from "../src/utils/maskStats";
