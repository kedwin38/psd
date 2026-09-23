import { SetMetadata } from "@nestjs/common";

export const STEP_UP_KEY = "stepUp";
/** Route requires a fresh (<=5min) WebAuthn re-assertion beyond the standing session (spec §12). */
export const StepUp = () => SetMetadata(STEP_UP_KEY, true);
