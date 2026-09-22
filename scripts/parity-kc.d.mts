/** Types for parity-kc.mjs, so the parity test can call the kosmo-callflow renderer. */
export type ParityCase = {
  name: string;
  description: string;
  change?: string;
  /** Overrides the fixture's sizes for one case; used only where a size cannot show the change. */
  sizes?: Array<[number, number]>;
  steps: unknown[];
};
export type ParityFixture = { sizes: Array<[number, number]>; cases: ParityCase[] };
export type KcKit = { viewState: unknown; render: unknown; replay: unknown; protocol: unknown };

export const KT_ROOT: string;
export const PARITY_DIR: string;
export const DEFAULT_KC_ROOT: string;
export function loadKc(kcRoot?: string): Promise<KcKit>;
export function expandSteps(cases: ParityCase[], steps: unknown[]): unknown[];
export function kcFrame(kc: KcKit, cases: ParityCase[], testCase: ParityCase, cols: number, rows: number): string[];
export function frameText(frame: readonly string[]): string;
export function goldenName(name: string, cols: number, rows: number): string;
