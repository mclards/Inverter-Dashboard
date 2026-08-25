"use strict";

const assert = require("assert");

const S3CompatibleProvider = require("../cloudProviders/s3");

function createTokenStore(initial = null) {
  const cache = Object.create(null);
  if (initial) cache.s3 = { ...initial };
  return {
    set(provider, value) {
      cache[provider] = { ...value };
    },
    get(provider) {
      return cache[provider] || null;
    },
    delete(provider) {
      delete cache[provider];
    },
  };
}

async function run() {
  {
    const tokenStore = createTokenStore();
    const provider = new S3CompatibleProvider(tokenStore, () => ({
      s3: {
        endpoint: "https://storage.example.com",
        region: "ap-southeast-1",
        bucket: "dashboard-backups",
        prefix: "InverterDashboardBackups",
        forcePathStyle: true,
      },
    }));
    const calls = [];
    provider._buildClient = (cfg, creds) => {
      assert.equal(cfg.bucket, "dashboard-backups");
      assert.equal(creds.accessKeyId, "access-id");
      assert.equal(creds.secretAccessKey, "secret-key");
      return {
        async send(cmd) {
          calls.push(cmd.constructor.name);
          return {};
        },
      };
    };
    const result = await provider.connect({
      accessKeyId: "access-id",
      secretAccessKey: "secret-key",
    });
    assert.deepEqual(calls, [
      "HeadBucketCommand",
      "PutObjectCommand",
      "DeleteObjectCommand",
    ]);
    assert.equal(result.bucket, "dashboard-backups");
    assert.equal(tokenStore.get("s3").accessKeyId, "access-id");
  }

  {
    const tokenStore = createTokenStore({
      accessKeyId: "stored-id",
      secretAccessKey: "stored-secret",
    });
    const provider = new S3CompatibleProvider(tokenStore, () => ({
      s3: {
        endpoint: "",
        region: "us-east-1",
        bucket: "dashboard-backups",
        prefix: "InverterDashboardBackups",
        forcePathStyle: false,
      },
    }));
    let buildCount = 0;
    provider._buildClient = (_cfg, creds) => {
      buildCount += 1;
      assert.equal(creds.accessKeyId, "stored-id");
      assert.equal(creds.secretAccessKey, "stored-secret");
      return {
        async send() {
          return {};
        },
      };
    };
    await provider.connect({
      accessKeyId: "",
      secretAccessKey: "",
    });
    assert.equal(buildCount, 1, "blank connect should reuse stored credentials");
    await assert.rejects(
      () =>
        provider.connect({
          accessKeyId: "partial-only",
          secretAccessKey: "",
        }),
      /Enter both S3 access key ID and secret access key/,
    );
  }

  {
    const tokenStore = createTokenStore({
      accessKeyId: "list-id",
      secretAccessKey: "list-secret",
    });
    const provider = new S3CompatibleProvider(tokenStore, () => ({
      s3: {
        endpoint: "https://storage.example.com",
        region: "auto",
        bucket: "dashboard-backups",
        prefix: "InverterDashboardBackups",
        forcePathStyle: true,
      },
    }));
    provider._buildClient = () => ({
      async send(cmd) {
        const prefix = String(cmd?.input?.Prefix || "");
        if (prefix === "InverterDashboardBackups/") {
          return {
            IsTruncated: false,
            Contents: [
              {
                Key: "InverterDashboardBackups/inverter-backup-2026-03-18/manifest.json",
                LastModified: new Date("2026-03-18T02:00:00Z"),
              },
              {
                Key: "InverterDashboardBackups/inverter-backup-2026-03-18/adsi.db",
                LastModified: new Date("2026-03-18T02:00:00Z"),
              },
              {
                Key: "InverterDashboardBackups/inverter-backup-2026-03-19/manifest.json",
                LastModified: new Date("2026-03-19T03:00:00Z"),
              },
            ],
          };
        }
        if (prefix === "InverterDashboardBackups/inverter-backup-2026-03-19") {
          return {
            IsTruncated: false,
            Contents: [
              {
                Key: "InverterDashboardBackups/inverter-backup-2026-03-19/manifest.json",
              },
              {
                Key: "InverterDashboardBackups/inverter-backup-2026-03-19/forecast/pv_dayahead_model_bundle.joblib",
              },
              {
                Key: "InverterDashboardBackups/inverter-backup-2026-03-19/history/context/global/global.json",
              },
            ],
          };
        }
        throw new Error(`unexpected prefix: ${prefix}`);
      },
    });
    const backups = await provider.listBackups();
    assert.deepEqual(
      backups.map((item) => item.id),
      [
        "inverter-backup-2026-03-19",
        "inverter-backup-2026-03-18",
      ],
    );
    const files = await provider.listBackupFiles("inverter-backup-2026-03-19");
    assert.deepEqual(
      files.map((item) => item.name),
      [
        "manifest.json",
        "forecast/pv_dayahead_model_bundle.joblib",
        "history/context/global/global.json",
      ],
    );
  }

  console.log("s3Provider.test.js: PASS");
}

run().catch((err) => {
  console.error("s3Provider.test.js: FAIL");
  console.error(err);
  process.exitCode = 1;
});
