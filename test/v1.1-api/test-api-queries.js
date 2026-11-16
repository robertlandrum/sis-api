describe('@API @V1.1API - Invalid queries', function() {
    "use strict";

    var should = require('should');
    var TestUtil = require('../fixtures/util');
    var ApiServer = new TestUtil.TestServer();

    // entities that happen to have the fields the commits API queries by
    var schema = {
        name : "test_invalid_queries",
        id_field : "name",
        _sis : { owner : ["test"] },
        definition : { name : { type : "String", required : true, unique : true },
                       entity_id : "String", type : "String" }
    };
    var url = "/api/v1.1/entities/" + schema.name;
    var entity = { name : "keep_me", entity_id : "x1", type : schema.name };

    before(function(done) {
        ApiServer.start(function(err) {
            if (err) { return done(err); }
            ApiServer.becomeSuperUser(done);
        });
    });

    before(async function() {
        await ApiServer.del("/api/v1.1/schemas/" + schema.name);
        await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
        await ApiServer.post(url).send(entity).expect(201);
    });

    after(async function() {
        await ApiServer.del("/api/v1.1/schemas/" + schema.name).expect(200);
    });

    after(function(done) {
        ApiServer.stop(done);
    });

    function expectInvalid(res) {
        res.body.error.should.match(/Query parameter is invalid/);
    }

    it("rejects them when listing", async function() {
        expectInvalid(await ApiServer.get(url).query({ q : "notjson" }).expect(400));
    });

    it("rejects them in bulk deletes", async function() {
        expectInvalid(await ApiServer.del(url).query({ q : "notjson" }).expect(400));
    });

    it("rejects them in bulk updates", async function() {
        expectInvalid(await ApiServer.put(url).query({ q : "notjson" }).send({ type : "changed" }).expect(400));
    });

    it("rejects them when listing commits", async function() {
        expectInvalid(await ApiServer.get(url + "/keep_me/commits").query({ q : "notjson" }).expect(400));
    });

    it("rejects them when listing tokens", async function() {
        var tokensUrl = "/api/v1.1/users/" + ApiServer.getSuperCreds().username + "/tokens";
        expectInvalid(await ApiServer.get(tokensUrl).query({ q : "notjson" }).expect(400));
    });

    it("does not let one request change the query of another", async function() {
        // these used to write the entity_id, type and username they query by
        // into the object every invalid query shared...
        await ApiServer.get(url + "/x1/commits").query({ q : "notjson" });
        await ApiServer.get("/api/v1.1/users/" + ApiServer.getSuperCreds().username + "/tokens")
            .query({ q : "notjson" });
        // ...so an invalid query then matched those, and these updated and
        // deleted the entity
        expectInvalid(await ApiServer.put(url).query({ q : "notjson" }).send({ type : "changed" }).expect(400));
        expectInvalid(await ApiServer.del(url).query({ q : "notjson" }).expect(400));
        var left = (await ApiServer.get(url + "/keep_me").expect(200)).body;
        left.type.should.eql(schema.name);
    });
});
