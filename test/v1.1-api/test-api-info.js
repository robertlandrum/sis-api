describe('@API @V1.1API - Info API', function() {
    "use strict";

    var should = require('should');

    var SIS = require("../../util/constants");

    var TestUtil = require('../fixtures/util');

    var ApiServer = new TestUtil.TestServer();

    it("Should setup fixtures", async function() {
        await ApiServer.start();
    });

    after(async function() {
        await ApiServer.stop();
    });

    it("should receive API info", async function() {
        var res = await ApiServer.get("/api/v1.1/info").expect(200);
        should.exist(res.body);
        should.not.exist(res.body.err);
        var keys = ['build_num', 'git_hash', 'build_id', 'version'];
        keys.forEach(function(k) { should.exist(res.body[k]); });
    });

    SIS.SUPPORTED_VERSIONS.forEach(function(v) {
        it("Should work for supported version " + v, async function() {
            await ApiServer.get("/api/" + v + "/info").expect(200);
        });
    });

    it("Should error on unsupported versions", async function() {
        await ApiServer.get("/api/unsupported/info")
            .expect(404);
    });
});
