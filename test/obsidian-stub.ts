// Runtime stand-in for the `obsidian` module, so pure helpers can be unit-tested.
export class TFile {}
export class Plugin {}
export class Notice {}
export { parse as parseYaml } from "yaml";
export function requestUrl(): Promise<{ status: number; headers: Record<string, string> }> {
	return Promise.reject(new Error("requestUrl is not mocked in this test"));
}
