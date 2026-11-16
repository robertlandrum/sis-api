describe("Hook Dispatch", function() {
    "use strict";

    var SIS = require("../util/constants");
    var should = require('should');
    var TestUtil = require('./fixtures/util');
    var ApiServer = new TestUtil.TestServer();

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
    });

    after(async function() {
        await ApiServer.stop();
    });

    // Start an http server on port for hooks to call.  handle(req, res)
    // answers each request, and next() resolves with the next request it
    // answered: { method, path, query, body, status }.
    async function startReceiver(port, handle) {
        var express = require('express');
        var app = express();
        // parse nested query strings (data[entity_type]=...) like Express 4 did
        app.set('query parser', 'extended');
        app.use(express.json());
        var answered = [];
        var waiting = [];
        app.use(function(req, res) {
            handle(req, res);
            var got = { method : req.method, path : req.path, query : req.query, body : req.body,
                        status : res.statusCode };
            if (waiting.length) {
                waiting.shift()(got);
            } else {
                answered.push(got);
            }
        });
        var server = await new Promise(function(resolve) {
            var s = app.listen(port, function() { resolve(s); });
        });
        return {
            next : function() {
                if (answered.length) {
                    return Promise.resolve(answered.shift());
                }
                return new Promise(function(resolve, reject) {
                    var waiter = function(got) {
                        clearTimeout(timer);
                        resolve(got);
                    };
                    var timer = setTimeout(function() {
                        waiting.splice(waiting.indexOf(waiter), 1);
                        reject(new Error("no hook request on port " + port + " within 5s"));
                    }, 5000);
                    waiting.push(waiter);
                });
            },
            close : function() {
                return new Promise(function(resolve) { server.close(resolve); });
            }
        };
    }

    describe("test-get-hook-dispatch", function() {
        var receiver = null;
        var hookName = "test_hook_get";
        var hook = null;
        var postCount = 0;

        before(async function() {
            receiver = await startReceiver(3335, function(req, res) {
                if (req.method === "POST" && !postCount++) {
                    // the first POST is answered with an error, to be retried
                    res.status(400).send("Need to retry.");
                } else {
                    res.send("ok");
                }
            });
            hook = {
                "name" : hookName,
                _sis : { "owner" : ["Test"] },
                "entity_type" : "sis_hiera",
                "target" : {
                    "action" : "GET",
                    "url" : "http://127.0.0.1:3335/hook"
                },
                "events": [ SIS.EVENT_INSERT ]
            };
            await ApiServer.post('/api/v1.1/hooks')
                .send(hook)
                .expect(201);
        });

        after(async function() {
            await receiver.close();
            await ApiServer.del('/api/v1.1/hooks/' + hookName)
                .expect(200);
        });

        var hiera_data = {
            "name" : "hiera_key",
            _sis : { "owner" : "test" },
            "hieradata" : {
                "field" : "String",
                "field2" : "Number"
            }
        };

        it("Should dispatch the hiera hook", async function() {
            await ApiServer.post("/api/v1.1/hiera")
                .set('content-type', 'application/json')
                .send(hiera_data)
                .expect(201);
            var got = await receiver.next();
            got.method.should.eql("GET");
            got.path.should.eql("/hook");
            should.exist(got.query.data);
            got.query.data.entity_type.should.eql("sis_hiera");
            got.query.data.hook.should.eql(hookName);
            got.query.data.event.should.eql(SIS.EVENT_INSERT);
        });

        it("Should dispatch the update hook and retry", async function() {
            hook.target.action = "POST";
            hook.target.url = "http://127.0.0.1:3335/hook_retry";
            hook.retry_count = 5;
            hook.retry_delay = 1;
            hook.events.push(SIS.EVENT_UPDATE);
            await ApiServer.put('/api/v1.1/hooks/' + hook.name)
                .send(hook).expect(200);
            hiera_data.hieradata.field3 = 'foo';
            await ApiServer.put("/api/v1.1/hiera/hiera_key")
                .set('content-type', 'application/json')
                .send(hiera_data)
                .expect(200);
            // the first attempt fails, the retry gets through
            var first = await receiver.next();
            first.path.should.eql("/hook_retry");
            first.status.should.eql(400);
            var retry = await receiver.next();
            retry.path.should.eql("/hook_retry");
            retry.status.should.eql(200);
            retry.body.event.should.eql(SIS.EVENT_UPDATE);
            retry.body.should.eql(first.body);
        });
    });

    describe("test-post-hook-dispatch", function() {
        var receiver = null;
        var hookName = "test_hook";

        before(async function() {
            receiver = await startReceiver(3334, function(req, res) {
                res.send("ok");
            });
            var hook = {
                "name" : hookName,
                _sis : { "owner" : [ "Test" ] },
                "entity_type" : SIS.SCHEMA_SCHEMAS,
                "target" : {
                    "action" : "POST",
                    "url" : "http://127.0.0.1:3334/hook"
                },
                "events": [ SIS.EVENT_INSERT, SIS.EVENT_UPDATE ]
            };
            await ApiServer.post('/api/v1.1/hooks')
                .send(hook)
                .expect(201);
        });

        after(async function() {
            await receiver.close();
            await ApiServer.del('/api/v1.1/hooks/' + hookName)
                .expect(200);
            await ApiServer.del("/api/v1.1/schemas/" + hookSchema.name);
        });

        var hookSchema = {
            "name" : "test",
            _sis :{ "owner" : "test" },
            "definition" : {
                "field" : "String",
                "field2" : "Number"
            }
        };

        it("Should dispatch the schema hook", async function() {
            await ApiServer.del("/api/v1.1/schemas/" + hookSchema.name);
            await ApiServer.post("/api/v1.1/schemas")
                .set('content-type', 'application/json')
                .send(hookSchema)
                .expect(201);
            var got = await receiver.next();
            got.method.should.eql("POST");
            got.body.entity_type.should.eql(SIS.SCHEMA_SCHEMAS);
            got.body.hook.should.eql(hookName);
            got.body.event.should.eql(SIS.EVENT_INSERT);
            got.body.data.name.should.eql(hookSchema.name);
        });
    });

    describe("Forced Triggers", function() {
        var receiver = null;
        var hookName = "test_force_trigger";
        var entity = null;

        before(async function() {
            receiver = await startReceiver(3335, function(req, res) {
                res.send("ok");
            });

            var schema = {
                name: "test_hook_trigger",
                _sis: { owner: ["sistest"] },
                definition: {
                    name: "String",
                    num: "Number"
                }
            };

            var hook = {
                "name" : hookName,
                _sis : { "owner" : [ "Test" ] },
                "entity_type" : "test_hook_trigger",
                "target" : {
                    "action" : "POST",
                    "url" : "http://127.0.0.1:3335/hook"
                },
                "events": [ SIS.EVENT_UPDATE ]
            };

            // nuke schema
            await ApiServer.del("/api/v1.1/schemas/test_hook_trigger");
            await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
            entity = (await ApiServer.post("/api/v1.1/entities/test_hook_trigger")
                .send({ name: "Forced Trigger", num: 1001 }).expect(201)).body;
            await ApiServer.post('/api/v1.1/hooks')
                .send(hook)
                .expect(201);
        });

        after(async function() {
            await receiver.close();
            await ApiServer.del("/api/v1.1/schemas/test_hook_trigger")
                .expect(200);
            await ApiServer.del('/api/v1.1/hooks/' + hookName)
                .expect(200);
        });

        it("Should trigger the hook", async function() {
            var res = await ApiServer.post("/api/v1.1/hooks/trigger/test_hook_trigger/" + entity._id)
                .set('content-type', 'application/json')
                .expect(200);
            should.exist(res.body.message);
            res.body.type.should.eql("test_hook_trigger");
            res.body.entity.should.eql(entity);
            // the hook gets the entity as both the new and the old value
            var got = await receiver.next();
            got.body.entity_type.should.eql("test_hook_trigger");
            got.body.hook.should.eql(hookName);
            got.body.event.should.eql(SIS.EVENT_UPDATE);
            got.body.data.should.eql(got.body.old_value);
            got.body.data.should.eql(entity);
        });
    });

    describe("Payloads", function() {
        // what hook receivers get is a public contract - pin all of it
        var received = [];
        var hookHttpServer = null;
        var schema = {
            name : "test_hook_payloads",
            id_field : "name",
            _sis : { owner : ["sistest"] },
            definition : { name : { type : "String", required : true, unique : true }, num : "Number" }
        };
        var url = "/api/v1.1/entities/" + schema.name;
        var hooks = ["POST", "GET"].map(function(action) {
            return {
                name : "test_hook_payloads_" + action.toLowerCase(),
                _sis : { owner : ["sistest"] },
                entity_type : schema.name,
                target : { action : action, url : "http://127.0.0.1:3336/" + action.toLowerCase() },
                events : [SIS.EVENT_INSERT, SIS.EVENT_UPDATE, SIS.EVENT_DELETE]
            };
        });

        before(async function() {
            var express = require('express');
            var receiver = express();
            receiver.set('query parser', 'extended');
            receiver.use(express.json());
            receiver.post('/post', function(req, res) {
                received.push({ action : "POST", body : req.body });
                res.send("ok");
            });
            receiver.get('/get', function(req, res) {
                received.push({ action : "GET", body : req.query.data });
                res.send("ok");
            });
            await new Promise(function(resolve) { hookHttpServer = receiver.listen(3336, resolve); });
            await ApiServer.del("/api/v1.1/schemas/" + schema.name);
            await ApiServer.post("/api/v1.1/schemas").send(schema).expect(201);
            for (var hook of hooks) {
                await ApiServer.del("/api/v1.1/hooks/" + hook.name);
                await ApiServer.post("/api/v1.1/hooks").send(hook).expect(201);
            }
        });

        after(async function() {
            hookHttpServer.close();
            for (var hook of hooks) {
                await ApiServer.del("/api/v1.1/hooks/" + hook.name).expect(200);
            }
            await ApiServer.del("/api/v1.1/schemas/" + schema.name).expect(200);
        });

        // resolves with the POST and GET payloads of the next write
        async function payloadsOf(request) {
            received = [];
            var res = await request;
            for (var waited = 0; received.length < 2 && waited < 5000; waited += 20) {
                await new Promise(function(resolve) { setTimeout(resolve, 20); });
            }
            received.length.should.eql(2);
            var byAction = { };
            received.forEach(function(r) { byAction[r.action] = r.body; });
            return { res : res.body, post : byAction.POST, get : byAction.GET };
        }

        function common(payload, event, isBulk) {
            payload.hook.should.eql("test_hook_payloads_post");
            payload.entity_type.should.eql(schema.name);
            payload.event.should.eql(event);
            payload.is_bulk.should.eql(isBulk);
        }

        it("sends the added entity", async function() {
            var p = await payloadsOf(ApiServer.post(url).send({ name : "p1", num : 1 }).expect(201));
            common(p.post, SIS.EVENT_INSERT, false);
            p.post.data.should.eql(p.res);
            should.not.exist(p.post.old_value);
            JSON.parse(p.get.data).should.eql(p.res);
            p.get.event.should.eql(SIS.EVENT_INSERT);
        });

        it("sends the updated entity and the old one", async function() {
            var old = (await ApiServer.get(url + "/p1").expect(200)).body;
            var p = await payloadsOf(ApiServer.put(url + "/p1").send({ num : 2 }).expect(200));
            common(p.post, SIS.EVENT_UPDATE, false);
            p.post.data.should.eql(p.res);
            p.post.old_value.should.eql(old);
            // a GET hook gets [old, updated, null] as JSON - what update used to resolve with
            var pair = JSON.parse(p.get.data);
            pair.length.should.eql(3);
            pair[0].num.should.eql(1);
            pair[1].should.eql(p.res);
            should(pair[2]).be.null();
            should.exist(p.get.old_value);
        });

        it("sends the deleted entity", async function() {
            var p = await payloadsOf(ApiServer.del(url + "/p1").expect(200));
            common(p.post, SIS.EVENT_DELETE, false);
            p.post.data.should.eql(p.res);
            should.not.exist(p.post.old_value);
        });

        it("sends an entity an upsert added as an insert", async function() {
            // num 3 keeps it out of the bulk tests below
            var p = await payloadsOf(ApiServer.put(url + "/u1").query({ upsert : true })
                                     .send({ name : "u1", num : 3 }).expect(201));
            common(p.post, SIS.EVENT_INSERT, false);
            p.post.data.should.eql(p.res);
            should.not.exist(p.post.old_value);
            JSON.parse(p.get.data).should.eql(p.res);
            p.get.event.should.eql(SIS.EVENT_INSERT);
        });

        it("sends an entity an upsert updated as an update", async function() {
            var p = await payloadsOf(ApiServer.put(url + "/u1").query({ upsert : true })
                                     .send({ name : "u1", num : 4 }).expect(200));
            common(p.post, SIS.EVENT_UPDATE, false);
            p.post.data.should.eql(p.res);
            p.post.old_value.num.should.eql(3);
        });

        it("sends the added entities of a bulk add", async function() {
            var p = await payloadsOf(ApiServer.post(url).send([{ name : "b1", num : 1 }, { name : "b2", num : 1 }])
                                     .expect(200));
            common(p.post, SIS.EVENT_INSERT, true);
            p.post.data.map(function(e) { return e.name; }).sort().should.eql(["b1", "b2"]);
            JSON.parse(p.get.data).length.should.eql(2);
        });

        it("sends the updated entities of a bulk update", async function() {
            // only the updated entities, without the old ones
            var p = await payloadsOf(ApiServer.put(url).query({ q : JSON.stringify({ num : 1 }) })
                                     .send({ num : 5 }).expect(200));
            common(p.post, SIS.EVENT_UPDATE, true);
            p.post.data.should.eql(p.res.success);
            p.post.data.map(function(e) { return [e.name, e.num]; }).sort().should.eql([["b1", 5], ["b2", 5]]);
            should.not.exist(p.post.old_value);
        });

        it("sends the deleted entities of a bulk delete", async function() {
            var p = await payloadsOf(ApiServer.del(url).query({ q : JSON.stringify({ num : 5 }) }).expect(200));
            common(p.post, SIS.EVENT_DELETE, true);
            p.post.data.map(function(e) { return e.name; }).sort().should.eql(["b1", "b2"]);
        });
    });
});
