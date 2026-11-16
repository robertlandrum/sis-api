describe('@API @V1.1API - Hiera API', function() {
    "use strict";

    var should = require('should');

    var SIS = require("../../util/constants");

    var TestUtil = require('../fixtures/util');

    var ApiServer = new TestUtil.TestServer();

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
    });

    after(async function() {
        await ApiServer.stop();
    });

    describe("Hiera failure cases", function() {
        it("Should error retrieving an unknown entry", async function() {
            await ApiServer.get("/api/v1.1/hiera/dne").expect(404);
        });
        it("Should error deleting an unknown entry", async function() {
            await ApiServer.del("/api/v1.1/hiera/dne").expect(404);
        });
        it("Should fail to add an entry missing 'name'", async function() {
            await ApiServer.post("/api/v1.1/hiera")
                .set("Content-Type", "application/json")
                .send({"hieradata" : {"this" : "should", "not" : "work"}})
                .expect(400);
        });
        it("Should fail to add an entry missing 'hieradata'", async function() {
            await ApiServer.post("/api/v1.1/hiera")
                .set("Content-Type", "application/json")
                .send({"name" : "whatever"})
                .expect(400);
        });
        it("Should fail to add an entry with null 'hieradata'", async function() {
            await ApiServer.post("/api/v1.1/hiera")
                .set("Content-Type", "application/json")
                .send({"name" : "whatever", hieradata : null })
                .expect(400);
        });
        it("Should fail to update an entry that doesn't exist", async function() {
            await ApiServer.put("/api/v1.1/hiera/dne")
                .set("Content-Type", "application/json")
                .send({"name" : "dne", _sis : { "owner" : "foo" }, "hieradata" : {"key1" : "v1"}})
                .expect(404);
        });
    });

    describe("Hiera success cases", function() {
        var item = {
            "name" : "host.name.here",
            _sis : { "owner" : "test" },
            "hieradata" : {
                "servers" : ["10.0.0.1", "10.0.0.2"],
                "port" : 80,
                "obj" : {
                    "k" : "k",
                    "j" : "j"
                }
            }
        };

        before(async function() {
            await ApiServer.del("/api/v1.1/hiera/" + item.name);
        });

        it("Should add the hiera entry", async function() {
            await ApiServer.post("/api/v1.1/hiera")
                .set("Content-Type", "application/json")
                .send(item)
                .expect(201);
        });
        it("Should receive only the data portion with key", async function() {
            var res = await ApiServer
                .get("/api/v1.1/hiera/host.name.here")
                .expect(200);
            should.exist(res.body['host.name.here']);
            var body = res.body['host.name.here'];
            should.exist(body.servers);
            should.exist(body.port);
        });
        it("Should remove the port key and add a name key", async function() {
            var res = await ApiServer
                .put("/api/v1.1/hiera/host.name.here")
                .set("Content-Type", "application/json")
                .send({"name" : "host.name.here", _sis : { "owner" : "test" }, "hieradata" : {"port" : null, "name" : "some_name"}})
                .expect(200);
            var hieradata = res.body.hieradata;
            should.exist(hieradata);
            should.exist(hieradata.servers);
            should.not.exist(hieradata.port);
            should.exist(hieradata.name);
        });
        it("Should remove the k field from obj and add the l field", async function() {
            var res = await ApiServer.put("/api/v1.1/hiera/host.name.here")
                .set("Content-Type", "application/json")
                .send({"name" : "host.name.here", _sis : { "owner" : "test" }, "hieradata" : { "obj" : { "k" : null, "l" : "l"} } })
                .expect(200);
            var hieradata = res.body.hieradata;
            should.exist(hieradata);
            should.exist(hieradata.servers);
            should.exist(hieradata.obj.j);
            should.not.exist(hieradata.obj.k);
            should.exist(hieradata.obj.l);
        });
        it("Should fail to update an entry with invalid data", async function() {
            await ApiServer.put("/api/v1.1/hiera/host.name.here")
                .set("Content-Type", "application/json")
                .send({"hieradata" : {"key1" : "v1"}})
                .expect(400);
        });
        it("Should fail to update entry with mismatched name and path", async function() {
            await ApiServer
                .put("/api/v1.1/hiera/host.name.here")
                .set("Content-Type", "application/json")
                .send({"name" : "does.not.match", _sis : { "owner" : "test" }, "hieradata" : {"should" : "fail"}})
                .expect(400);
        });
        it("Should delete the hiera entry", async function() {
            await ApiServer.del("/api/v1.1/hiera/host.name.here")
                .expect(200);
        });
    });

    describe("Non object type support", function() {
        var initialValue = { test : "data" };
        var values = [
            100,
            ["this","is",{ name : "a" }, "list", 20],
            "a string",
            { "a" : "non empty hash" },
            [],
            { },
            200
        ];
        var hieraEntry = {
            name : "non_objects",
            _sis : { owner : ["test"] },
            hieradata : initialValue
        };

        // the write's response and the entry read back both hold value
        async function ensureEqual(res, value) {
            var hieradata = res.body.hieradata;
            should.exist(hieradata);
            hieradata.should.eql(value);
            var hieraObject = (await ApiServer.get("/api/v1.1/hiera/" + hieraEntry.name).expect(200)).body;
            should.exist(hieraObject[hieraEntry.name]);
            hieraObject[hieraEntry.name].should.eql(value);
        }

        before(async function() {
            await ApiServer.del("/api/v1.1/hiera/" + hieraEntry.name);
            var res = await ApiServer.post("/api/v1.1/hiera")
                .set("Content-Type", "application/json")
                .send(hieraEntry)
                .expect(201);
            await ensureEqual(res, initialValue);
        });

        values.forEach(function(val) {
            it("Should set hiera to " + JSON.stringify(val), async function() {
                hieraEntry.hieradata = val;
                var res = await ApiServer.put("/api/v1.1/hiera/" + hieraEntry.name)
                    .set("Content-Type", "application/json")
                    .send(hieraEntry)
                    .expect(200);
                await ensureEqual(res, val);
            });
        });
    });
});
