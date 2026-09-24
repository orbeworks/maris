import assert from "node:assert/strict";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type { DataSource } from "typeorm";
import { ChartCell } from "../ingestions/entities/chart-cell.entity.js";
import { ChartVersion } from "../ingestions/entities/chart-version.entity.js";
import type { ChartStorage } from "../tiles/storage/chart-storage.js";
import { ChartsController } from "./charts.controller.js";
import { ChartsService } from "./charts.service.js";
import { ChartQueryDto } from "./dtos/chart-query.dto.js";
import { CHART_SELECTION_POLICY } from "./models/chart-selection.js";

test("endpoint returns exactly one chart from requested published version, with spatial survey data", async () => {
  let where: unknown,
    policy: string | undefined = CHART_SELECTION_POLICY;
  const geometry = {
    type: "Polygon",
    coordinates: [
      [
        [-81, 25],
        [-79, 25],
        [-79, 27],
        [-81, 27],
        [-81, 25],
      ],
    ],
  };
  const cells = [80000, 22000].map((scale, i) => ({
    id: `cell-${i}`,
    name: `ENC${i}`,
    source: "NOAA",
    edition: "2",
    updateNumber: 0,
    updatesApplied: [],
    compilationScale: scale,
    coverages: [{ category: 1, geometry }],
    issueDate: "2025-01-01",
    updateApplicationDate: "2025-01-01",
    coveredAreaNames: [],
    horizontalDatum: 2,
    soundingDatum: 12,
    verticalDatum: null,
  }));
  const database = {
    getRepository: (entity: unknown) =>
      entity === ChartVersion
        ? {
            findOne: async (options: { where: unknown }) => {
              where = options.where;
              return {
                id: "v",
                versionKey: "old-published",
                processedAt: new Date("2026-01-01"),
                publishedAt: new Date("2026-01-02"),
              };
            },
          }
        : {
            find: async () =>
              entity === ChartCell
                ? cells
                : [
                    {
                      geometry,
                      dataQuality: 3,
                      objectClass: "M_QUAL",
                      surveySource: "real source",
                      surveyDate: "2008-01-01",
                      surveyStartedAt: null,
                      surveyEndedAt: null,
                    },
                    {
                      geometry: { type: "Point", coordinates: [0, 0] },
                      dataQuality: 1,
                      surveySource: "elsewhere",
                    },
                  ],
          },
  } as unknown as DataSource;
  const storage = {
    getManifest: async () => ({ selectionPolicy: policy }),
  } as unknown as ChartStorage;
  const service = new ChartsService(database, storage);
  const module = await Test.createTestingModule({
    controllers: [ChartsController],
    providers: [{ provide: ChartsService, useValue: service }],
  }).compile();
  const app = module.createNestApplication();
  await app.init();
  try {
    const response = await request(app.getHttpServer())
      .get("/charts/at-point?lat=26&lon=-80&version=old-published")
      .expect(200);
    assert.equal(response.body.name, "ENC1");
    assert.equal(Array.isArray(response.body), false);
    assert.deepEqual(response.body.dataQuality, [3]);
    assert.equal(response.body.surveys.length, 1);
    assert.deepEqual(where, {
      status: "published",
      dataset: { key: "soundg" },
      versionKey: "old-published",
    });
    await request(app.getHttpServer())
      .get("/charts/at-point?lat=0&lon=0")
      .expect(404);
    assert.deepEqual(where, {
      status: "published",
      dataset: { key: "soundg" },
      active: true,
    });
    for (const query of [
      "lat=&lon=0",
      "lat=91&lon=0",
      "lat=0&lon=181",
      "lat=NaN&lon=0",
      "lat=0&lon=0&version=../bad",
      "lat=0&lat=1&lon=0",
    ]) {
      await request(app.getHttpServer())
        .get(`/charts/at-point?${query}`)
        .expect(400);
    }
    policy = undefined;
    await assert.rejects(
      service.atPoint(new ChartQueryDto(26, -80)),
      /legacy dataset/,
    );
  } finally {
    await app.close();
  }
});
