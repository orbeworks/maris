import assert from "node:assert/strict";
import { test } from "node:test";
import { chartInformationRows, type ChartInformation } from "./chart-information";

const chart: ChartInformation = {
  id: "cell", name: "US5MIABC", source: "NOAA", edition: "2", updateNumber: 0,
  issueDate: "2025-09-03", updateApplicationDate: null, compilationScale: 22000,
  coveredAreaNames: ["Biscayne Bay"], horizontalDatum: 2, soundingDatum: 12,
  dataQuality: [3], surveys: [{ source: null, date: null }],
  processedAt: "2026-09-18T01:00:00Z", version: "soundg-test",
};

test("chart rows display real metadata, known ENC labels and missing values", () => {
  const rows = Object.fromEntries(chartInformationRows(chart));
  assert.equal(rows["ENC Cell"], "US5MIABC");
  assert.equal(rows["Compilation Scale"], "1:22,000");
  assert.equal(rows["Data Quality"], "CATZOC B");
  assert.equal(rows["Horizontal Datum"], "WGS 84");
  assert.equal(rows["Sounding Datum"], "Mean lower low water");
  assert.equal(rows["Last Update Applied"], "Not provided");
  assert.equal(rows["Survey Source"], "Not provided");
  assert.equal(rows["Processed by MARIS"], "2026-09-18");
});

test("unknown datum codes remain traceable and survey values are deduplicated", () => {
  const rows = Object.fromEntries(chartInformationRows({ ...chart, horizontalDatum: 999,
    surveys: [{ source: "NOAA", date: "2020" }, { source: "NOAA", date: "2020" }] }));
  assert.equal(rows["Horizontal Datum"], "ENC code 999");
  assert.equal(rows["Survey Source"], "NOAA");
  assert.equal(rows["Survey Date"], "2020");
});
