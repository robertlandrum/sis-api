import should from "should";
import SIS from "../../util/constants.js";
import * as TestUtil from "../fixtures/util.js";

describe('@API @V1.1API - Hook API', function() {
    var ApiServer = new TestUtil.TestServer();


    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
    });

    after(async function() {
        await ApiServer.stop();
    });

    describe("Hooks failure cases", function() {
        // no hooks.
        it("Should fail if name does not exist ", async function() {
            await ApiServer.get("/api/v1.1/hooks/DNE").expect(404);
        });
        it("Should fail to delete non existent hook", async function() {
            await ApiServer.del("/api/v1.1/hooks/DNE")
                .expect(404);
        });
        it("Should fail to create an invalid hook", async function() {
            await ApiServer.post("/api/v1.1/hooks")
                .set("Content-Type", "application/json")
                .send({"invalid" : "hook"})
                .expect(400);
        });
        it("Should fail to update a hook that doens't exist", async function() {
            var hook = {
                "name" : "DNE",
                _sis : { "owner" : [ "Test" ] },
                "entity_type" : "Schema",
                "target" : {
                    "action" : "POST",
                    "url" : "http://foo.bar.com/foo"
                },
                "events": ['insert','update']
            };
            await ApiServer.put("/api/v1.1/hooks/DNE")
                .set("Content-Type", "application/json")
                .send(hook)
                .expect(404);
        });
    });

    describe("CRUD hooks", function() {
        var hook = {
            "name" : "test_hook",
            _sis : { "owner" : [ "Test" ] },
            "entity_type" : "Schema",
            "target" : {
                "action" : "POST",
                "url" : "http://foo.bar.com/foo"
            },
            "events": ['insert','update']
        };
        before(async function() {
            await ApiServer.del('/api/v1.1/hooks/' + hook.name);
        });

        it("Should create new hook", async function() {
            await ApiServer.post("/api/v1.1/hooks")
                .set('content-type', 'application/json')
                .send(hook)
                .expect(201);
        });
        it("Should retrieve the hook", async function() {
            var res = await ApiServer.get("/api/v1.1/hooks/test_hook")
                .expect(200);
            should.exist(res.body);
            for (var k in hook) {
                if (k === '_sis') { continue; }
                hook[k].should.eql(res.body[k]);
            }
        });
        it("Should update the hook", async function() {
            hook.events = ['insert'];
            var result = await ApiServer.put("/api/v1.1/hooks/test_hook")
                .set("Content-Type", "application/json")
                .send(hook)
                .expect(200);
            should.exist(result.body);
            should.exist(result.body.events);
            result.body.events.length.should.eql(1);
        });
        it("Should fail to update the hook w/ invalid data", async function() {
            delete hook.events;
            await ApiServer.put("/api/v1.1/hooks/test_hook")
                .set("Content-Type", "application/json")
                .send(hook)
                .expect(400);
        });
        it ("Should delete the hook", async function() {
            await ApiServer.del("/api/v1.1/hooks/test_hook")
                .expect(200);
        });
    });

    describe("Hook search", function() {
        var names = ["test_hook1", "test_hook2", "test_hook3"];

        before(async function() {
            // insert three hooks
            await Promise.all(names.map(function(name) {
                var hook = {
                    "name" : name,
                    _sis : { "owner" : [ "Test" ] },
                    "entity_type" : "Schema",
                    "target" : {
                        "action" : "POST",
                        "url" : "http://foo.bar.com/foo"
                    },
                    "events": ['insert','update']
                };
                return ApiServer.post('/api/v1.1/hooks').send(hook).expect(201);
            }));
        });
        after(async function() {
            await Promise.all(names.map(function(name) {
                return ApiServer.del('/api/v1.1/hooks/' + name).expect(200);
            }));
        });
        it("Should return 2 results", async function() {
            var res = await ApiServer.get("/api/v1.1/hooks")
                .query({ offset : 1, limit : 2})
                .expect(200);
            res.body.length.should.eql(2);
        });
        it("Should return 1 results", async function() {
            var res = await ApiServer.get("/api/v1.1/hooks")
                .query({ q: JSON.stringify({"name" : "test_hook1"}) })
                .expect(200);
            res.body.length.should.eql(1);
        });
    });

});
