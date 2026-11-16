import should from "should";
import express from "express";
import SIS from "../util/constants.js";
import * as TestUtil from "./fixtures/util.js";
import createSchemaManager from "../util/schema-manager.js";
import createHookManager, { lookupsDone } from "../util/hook-manager.js";

describe('HookManager', function() {
    var LocalTest = new TestUtil.LocalTest();
    var expectError = TestUtil.expectError;

    var hookManager = null;

    before(async function() {
        var mongoose = await LocalTest.start();
        var schemaManager = createSchemaManager(mongoose, { auth : false});
        hookManager = createHookManager(schemaManager);
    });

    after(async function() {
        await LocalTest.stop();
    });

    describe('add-invalid-hook', function() {
        it("should error adding an empty string ", async function() {
            var hook = "";
            await expectError(hookManager.add(hook), 400, /No model defined/);
        });

        it("should error adding an empty object ", async function() {
            var hook = { };
            await expectError(hookManager.add(hook), 400, /Hook has no name/);
        });


        it("should error adding a hook with no name ", async function() {
            var hook = {
                "name" : "",
                _sis : { "owner" : [ "Test" ] },
                "entity_type" : "Schema",
                "target" : {
                    "action" : "POST",
                    "url" : "http://foo.bar.com/foo"
                },
                "events": ['insert','update']
            };
            await expectError(hookManager.add(hook), 400, /Hook has no name/);
        });

        it("should error adding a hook with no owner ", async function() {
            var hook = {
                "name" : "test_hook",
                "entity_type" : "Schema",
                "target" : {
                    "action" : "POST",
                    "url" : "http://foo.bar.com/foo"
                },
                "events": ['insert','update']
            };
            // auth is off, so the model's validation catches it
            await expectError(hookManager.add(hook), 400, /owner is required/);
        });

        it("should error adding a hook with no entity_type ", async function() {
            var hook = {
                "name" : "test_hook",
                _sis : { "owner" : [ "Test" ] },
                "target" : {
                    "action" : "POST",
                    "url" : "http://foo.bar.com/foo"
                },
                "events": ['insert','update']
            };
            await expectError(hookManager.add(hook), 400, /Hook has no entity_type/);
        });

        it("should error adding a hook with no target ", async function() {
            var hook = {
                "name" : "test_hook",
                _sis : { "owner" : ["Test"] },
                "entity_type" : "Schema",
                "events": ['insert','update']
            };
            await expectError(hookManager.add(hook), 400, /Hook has no target/);
        });
        it("should error adding a hook with no target.url ", async function() {
            var hook = {
                "name" : "test_hook",
                _sis : { "owner" : ["Test"] },
                "entity_type" : "Schema",
                "target" : {
                    "action" : "POST"
                },
                "events": ['insert','update']
            };
            await expectError(hookManager.add(hook), 400, /Hook target has no url/);
        });
        it("should error adding a hook with no target.action ", async function() {
            var hook = {
                "name" : "test_hook",
                _sis : { "owner" : ["Test"] },
                "entity_type" : "Schema",
                "target" : {
                    "url" : "http://foo.bar.com/foo"
                },
                "events": ['insert','update']
            };
            await expectError(hookManager.add(hook), 400, /Hook target has no action/);
        });
        it("should error adding a hook with no events ", async function() {
            var hook = {
                "name" : "test_hook",
                _sis : { "owner" : ["Test"] },
                "entity_type" : "Schema",
                "target" : {
                    "action" : "POST",
                    "url" : "http://foo.bar.com/foo"
                }
            };
            await expectError(hookManager.add(hook), 400, /Hook has no on parameter/);
        });
        it("should error adding a hook with no event values ", async function() {
            var hook = {
                "name" : "test_hook",
                _sis : { "owner" : ["Test"] },
                "entity_type" : "Schema",
                "target" : {
                    "action" : "POST",
                    "url" : "http://foo.bar.com/foo"
                },
                "events": []
            };
            await expectError(hookManager.add(hook), 400, /Hook on parameter has no values/);
        });

    });

    describe('add-valid-hook', function() {
        var hookName = "test_hook";
        after(async function() {
            await hookManager.delete(hookName);
        });
        it("should add a valid hook object", async function() {
            var hook = {
                "name" : hookName,
                _sis : { "owner" : [ "Test" ] },
                "entity_type" : "Schema",
                "target" : {
                    "action" : "POST",
                    "url" : "http://foo.bar.com/foo"
                },
                "events": ['insert','update']
            };
            var entity = await hookManager.add(hook);
            entity.should.have.property('name', 'test_hook');
            entity.should.have.property('entity_type', 'Schema');
            entity.toObject().target.should.eql(hook.target);

            JSON.stringify(entity.events).should.eql(JSON.stringify(hook.events));
        });
    });

    describe('delete-hook', function() {
        var hookName = "delete_test";
        var hook = {
            "name" : hookName,
            _sis : { "owner" : ["Test"] },
            "entity_type" : "Schema",
            "target" : {
                "action" : "POST",
                "url" : "http://foo.bar.com/foo"
            },
            "events": ['insert','update']
        };

        before(async function() {
            await hookManager.add(hook);
        });

        it("Should fail to delete a hook that does not exist", async function() {
            await expectError(hookManager.delete("dne"), 404);
        });

        it("Should delete the hook", async function() {
            (await hookManager.delete(hookName)).name.should.eql(hookName);
        });

        it("Should no longer exist ", async function() {
            await expectError(hookManager.getById(hookName), 404);
        });

    });

    describe("update-hook", function() {
        var hookName = "update_test";
        var initialHook = {
            "name" : hookName,
            _sis : { "owner" : [ "Test" ] },
            "entity_type" : "Schema",
            "target" : {
                "action" : "POST",
                "url" : "http://foo.bar.com/foo"
            },
            "events": ['insert','update']
        };
        var updatedHook = {
            "name" : hookName,
            _sis: { "owner" : [ "Bob" ] },
            "entity_type" : "EntityA",
            "target" : {
                "action" : "GET",
                "url" : "http://frob.com/foo"
            },
            "events": ['update']
        };

        // create the hook
        before(async function() {
            await hookManager.add(initialHook);
        });
        after(async function() {
            await hookManager.delete(hookName);
        });

        it("Should update the hook", async function() {
            var updated = (await hookManager.update(hookName, updatedHook)).updated;
            updated.should.have.property('entity_type','EntityA');
            updated.toObject().target.should.eql(updatedHook.target);
            JSON.stringify(updated.events).should.eql(JSON.stringify(updatedHook.events));
        });
    });

    describe('dispatch', function() {
        var receiver = null;
        var attempts = 0;
        var failuresLeft = 0;

        before(async function() {
            var app = express();
            app.use(express.json());
            app.post('/hook', function(req, res) {
                attempts++;
                if (failuresLeft > 0) {
                    failuresLeft--;
                    return res.status(503).send("busy");
                }
                res.send("got " + req.body.event);
            });
            await new Promise(function(resolve) { receiver = app.listen(3337, resolve); });
        });

        after(async function() {
            await new Promise(function(resolve) { receiver.close(resolve); });
        });

        async function addHook(name, url, retries) {
            await hookManager.add({
                name : name,
                _sis : { owner : ["Test"] },
                entity_type : "dispatch_type_" + name,
                target : { action : "POST", url : url },
                events : [SIS.EVENT_INSERT],
                retry_count : retries,
                retry_delay : 1
            });
            return "dispatch_type_" + name;
        }

        beforeEach(function() {
            attempts = 0;
            failuresLeft = 0;
        });

        it("resolves with what the hooks answered", async function() {
            var type = await addHook("dispatch_ok", "http://127.0.0.1:3337/hook", 0);
            (await hookManager.dispatchHooks({ name : "e" }, type, SIS.EVENT_INSERT, false)).should.eql(["got insert"]);
            attempts.should.eql(1);
        });

        it("retries a hook that fails", async function() {
            var type = await addHook("dispatch_retry", "http://127.0.0.1:3337/hook", 2);
            failuresLeft = 1;
            (await hookManager.dispatchHooks({ name : "e" }, type, SIS.EVENT_INSERT, false)).should.eql(["got insert"]);
            attempts.should.eql(2);
        });

        it("resolves with null once the retries are used up", async function() {
            var type = await addHook("dispatch_fail", "http://127.0.0.1:3337/hook", 1);
            failuresLeft = 5;
            should(await hookManager.dispatchHooks({ name : "e" }, type, SIS.EVENT_INSERT, false)).be.null();
            attempts.should.eql(2);
        });

        it("resolves with nothing for types without hooks", async function() {
            (await hookManager.dispatchHooks({ name : "e" }, "no_hooks_here", SIS.EVENT_INSERT, false)).should.eql([]);
        });

        it("tracks the hook lookups that are running", async function() {
            var dispatch = hookManager.dispatchHooks({ name : "e" }, "no_hooks_here", SIS.EVENT_INSERT, false);
            await lookupsDone();
            await dispatch;
        });
    });
});
