import { describe, expect, mock, test } from "bun:test";

describe("ensureModelCatalogAvailable", () => {
	test("refreshes synchronously when catalog is missing", async () => {
		const errors: string[] = [];
		const refresh = mock(async () => {});
		let exists = false;
		const { ensureModelCatalogAvailable } = await import("../src/provider/model-catalog-startup");

		await ensureModelCatalogAvailable({
			catalogExists: () => exists,
			refreshCatalog: async () => {
				await refresh();
				exists = true;
			},
			logger: {
				error(_system: string, message: string) {
					errors.push(message);
				},
			},
		});

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(errors).toEqual([]);
	});

	test("logs error and fails when catalog is missing and refresh fails", async () => {
		const errors: string[] = [];
		const { ensureModelCatalogAvailable } = await import("../src/provider/model-catalog-startup");

		await expect(
			ensureModelCatalogAvailable({
				catalogExists: () => false,
				refreshCatalog: async () => {
					throw new Error("network down");
				},
				logger: {
					error(_system: string, message: string) {
						errors.push(message);
					},
				},
			}),
		).rejects.toThrow(/network down/);

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("Model catalog refresh failed");
	});

	test("logs error and continues when stale catalog exists after refresh failure", async () => {
		const errors: string[] = [];
		let firstCheck = true;
		const { ensureModelCatalogAvailable } = await import("../src/provider/model-catalog-startup");

		await ensureModelCatalogAvailable({
			catalogExists: () => {
				if (firstCheck) {
					firstCheck = false;
					return false;
				}
				return true;
			},
			refreshCatalog: async () => {
				throw new Error("docs unavailable");
			},
			logger: {
				error(_system: string, message: string) {
					errors.push(message);
				},
			},
		});

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("Using existing stale model catalog");
	});
});
