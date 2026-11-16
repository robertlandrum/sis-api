import should from "should";
import fs from "fs";
import path from "path";
import * as TestUtil from "../fixtures/util.js";

describe('@API @V1.1API - Samples', function() {
    var ApiServer = new TestUtil.TestServer();

    // the example payloads in samples/ are what the docs point people to,
    // so they must work against the API as they are
    function sample(name) {
        return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "samples", name), "utf8"));
    }

    var schema = sample("schema_sample.json");

    before(async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
        await ApiServer.del("/api/v1.1/schemas/" + schema.name);
    });

    after(async function() {
        await ApiServer.del("/api/v1.1/schemas/" + schema.name);
        await ApiServer.stop();
    });

    it("adds the sample schema and entity", async function() {
        await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
        var entity = sample("entity_sample.json");
        var res = await ApiServer.post("/api/v1.1/entities/" + schema.name).send(entity).expect(201);
        res.body.requiredField.should.eql(entity.requiredField);
    });

    ["hook_sample.json", "hook_schema.json"].forEach(function(file) {
        it("adds the sample hook " + file, async function() {
            var hook = sample(file);
            await ApiServer.del("/api/v1.1/hooks/" + hook.name);
            await ApiServer.post("/api/v1.1/hooks").send(hook).expect(201);
            await ApiServer.del("/api/v1.1/hooks/" + hook.name).expect(200);
        });
    });

    it("adds the sample hiera entry", async function() {
        var hiera = sample("hiera_common.json");
        await ApiServer.del("/api/v1.1/hiera/" + hiera.name);
        var res = await ApiServer.post("/api/v1.1/hiera").send(hiera).expect(201);
        res.body.hieradata.should.eql(hiera.hieradata);
        await ApiServer.del("/api/v1.1/hiera/" + hiera.name).expect(200);
    });
});
