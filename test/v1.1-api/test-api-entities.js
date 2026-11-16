import should from "should";
import SIS from "../../util/constants.js";
import * as TestUtil from "../fixtures/util.js";

describe('@API @V1.1API - Entity API', function() {
    var ApiServer = new TestUtil.TestServer();

    it("Should setup fixtures", async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
    });

    after(async function() {
        await ApiServer.stop();
    });

    // delete the schema if it is there and add it
    async function recreateSchema(schema) {
        await ApiServer.del("/api/v1.1/schemas/" + schema.name);
        await ApiServer.post('/api/v1.1/schemas').send(schema).expect(201);
    }

    function deleteSchema(schema) {
        return ApiServer.del("/api/v1.1/schemas/" + schema.name).expect(200);
    }

    describe("Entity Failure cases", function() {
        // no schemas..
        it("Should fail if type is not specified ", async function() {
            await ApiServer.get("/api/v1.1/entities").expect(404);
        });
        it("Should fail if type does not exist ", async function() {
            await ApiServer.get("/api/v1.1/entities/sis_dne").expect(404);
        });
        it("Should fail to add an entity for a dne schema", async function() {
            await ApiServer.post("/api/v1.1/entities/sis_dne")
                .set("Content-Type", "application/json")
                .send({"this" : "should", "not" : "work"})
                .expect(404);
        });
        it("Should fail to get an entity by id of a particular type that does not exist", async function() {
            await ApiServer.get("/api/v1.1/entities/sis_dne/some_id")
                .expect(404);
        });
        it("Should fail to delete an entity for dne schema", async function() {
            await ApiServer.del("/api/v1.1/entities/sis_dne/some_id")
                .expect(404);
        });
    });

    describe("CRUD Entity", function() {
        var schema = {
            "name":"test_entity",
            _sis : { "owner" : ["sistest"] },
            "definition": {
                "str":   "String",
                "num":   "Number",
                "date":  "Date",
                "bool":  "Boolean",
                "arr": [],
            }
        };
        before(async function() {
            await recreateSchema(schema);
        });

        var entityId = null;
        var expectedEntity = {
            "str" : "testing",
            "num" : 123,
            "date" : new Date(2013, 10, 1),
            "bool" : true,
            "arr" : ["sis"]
        };

        // the response holds the expected entity, with the id of the first
        var expectEntity = function(res) {
            should.exist(res.body);
            should.exist(res.body._id);
            if (!entityId) {
                entityId = res.body._id;
            } else {
                entityId.should.eql(res.body._id);
            }
            for (var k in expectedEntity) {
                should.exist(res.body[k]);
                JSON.stringify(expectedEntity[k]).should.eql(JSON.stringify(res.body[k]));
            }
        };

        it("Should add the entity ", async function() {
            expectEntity(await ApiServer.post("/api/v1.1/entities/" + schema.name)
                .set('Content-Type', 'application/json')
                .send(expectedEntity)
                .expect(201));
        });

        it("Should retrieve the added entity ", async function() {
            expectEntity(await ApiServer.get("/api/v1.1/entities/" + schema.name + "/" + entityId)
                .set('Content-Type', 'application/json')
                .expect(200));
        });

        it("Should update the str to foobar ", async function() {
            expectedEntity.str = "foobar";
            expectEntity(await ApiServer.put("/api/v1.1/entities/" + schema.name + "/" + entityId)
                .set('Content-Type', 'application/json')
                .send(expectedEntity)
                .expect(200));
        });
        it("Should not add an invalid entity ", async function() {
            var invalid = {
                "str" : "testing",
                "num" : 123,
                "date" : new Date(2013, 10, 1),
                "bool" : "bogus",
                "arr" : "not an array"
            };
            await ApiServer.post("/api/v1.1/entities/" + schema.name)
                .set('Content-Type', 'application/json')
                .send(invalid)
                .expect(400);
        });
        it("Should delete the added entity", async function() {
            await ApiServer.del("/api/v1.1/entities/" + schema.name + "/" + entityId)
                .expect(200);
        });
        it("Should fail to add an entity with _id", async function() {
            expectedEntity._id = 'foobar';
            await ApiServer.post("/api/v1.1/entities/" + schema.name)
                .set("Content-Type", "application/json")
                .send(expectedEntity)
                .expect(400);
        });
        it("Should fail to update an entity that doesn't exist", async function() {
            delete expectedEntity._id;
            await ApiServer.put("/api/v1.1/entities/" + schema.name + "/foobar")
                .set("Content-Type", "application/json")
                .send(expectedEntity)
                .expect(404);
        });
        it("Should fail to delete entity that doesn't exist", async function() {
            await ApiServer.del("/api/v1.1/entities/" + schema.name + "/some_id")
                .expect(404);
        });
        it("Should fail to add an empty entity", async function() {
            await ApiServer.post("/api/v1.1/entities/" + schema.name)
                .set("Content-Type", "application/json")
                .send({})
                .expect(400);
        });
    });

    // the object of the response is entity, apart from the SIS meta data
    function expectSameAs(res, entity) {
        var result = res.body;
        delete entity._sis;
        delete result._sis;
        result.should.eql(entity);
    }

    describe("Partial entity updates", function() {
        var schema = {
            "name":"test_nested_entity",
            _sis : { "owner" : ["sistest"] },
            "definition": {
                "str":   "String",
                "num":   "Number",
                "nested_obj" : {
                    "str" : "String",
                    "obj2" : {
                        "name" : "String",
                        "other_field" : "String"
                    }
                },
                "mixed_obj" : "Mixed"
            }
        };
        var entity = {
            "str" : "foo",
            "num" : 20,
            "nested_obj" : {
                "str" : "bar",
                "obj2" : {
                    "name" : "baz",
                    "other_field" : "werd"
                }
            },
            "mixed_obj" : {
                "crazy" : "stuff",
                "goes" : "here"
            }
        };
        var entityUrl = function() {
            return "/api/v1.1/entities/test_nested_entity/" + entity._id;
        };
        before(async function() {
            await recreateSchema(schema);
            entity = (await ApiServer.post("/api/v1.1/entities/test_nested_entity")
                .set("Content-Type", "application/json")
                .send(entity).expect(201)).body;
            should.exist(entity);
            should.exist(entity.nested_obj);
            should.exist(entity.nested_obj.obj2);
            should.exist(entity.nested_obj.obj2.name);
        });
        after(async function() {
            await deleteSchema(schema);
        });
        it("Should update nested_obj.obj2.name only", async function() {
            entity.nested_obj.obj2.name = "hello";
            expectSameAs(await ApiServer.put(entityUrl())
                .set("Content-Type", "application/json")
                .send({"nested_obj" : { "obj2" : { "name" : "hello" } } })
                .expect(200), entity);
        });
        it("Should update delete 'crazy' from mixed_obj and add 'awesome'", async function() {
            delete entity.mixed_obj.crazy;
            entity.mixed_obj.awesome = 'here';
            expectSameAs(await ApiServer.put(entityUrl())
                .set("Content-Type", "application/json")
                .send({"mixed_obj" : {"crazy" : null, "awesome" : "here"}})
                .expect(200), entity);
        });
        it("Should change the type of mixed_obj to a string", async function() {
            entity.mixed_obj = "random string";
            expectSameAs(await ApiServer.put(entityUrl())
                .set("Content-Type", "application/json")
                .send({"mixed_obj" : "random string"})
                .expect(200), entity);
        });
        it("Should change type of mixed_obj to a dict again", async function() {
            entity.mixed_obj = { "key" : "value" };
            expectSameAs(await ApiServer.put(entityUrl())
                .set("Content-Type", "application/json")
                .send({"mixed_obj" : entity.mixed_obj })
                .expect(200), entity);
        });
        it("Should change mixed_obj to null", async function() {
            entity.mixed_obj = null;
            expectSameAs(await ApiServer.put(entityUrl())
                .set("Content-Type", "application/json")
                .send({"mixed_obj" : entity.mixed_obj })
                .expect(200), entity);
        });
        it("Should change mixed_obj back to a dict", async function() {
            entity.mixed_obj = {"hello":"world"};
            expectSameAs(await ApiServer.put(entityUrl())
                .set("Content-Type", "application/json")
                .send({"mixed_obj" : entity.mixed_obj })
                .expect(200), entity);
        });
    });

    describe("Entity locking", function() {
        var schema = {
            "name":"test_locked_entity",
            _sis : { "owner" : ["sistest"] },
            "definition": {
                "str":   "String",
                "num":   "Number"
            }
        };
        var initial = {
            "str" : "foo",
            "num" : 20
        };
        var entityId = null;
        before(async function() {
            await recreateSchema(schema);
            var entity = (await ApiServer.post("/api/v1.1/entities/test_locked_entity")
                .send(initial)
                .expect(201)).body;
            entityId = entity._id;
            should.exist(entity);
            should.exist(entity.str);
            should.exist(entity.num);
            should.exist(entity._sis.locked);
        });
        it("should lock the entity", async function() {
            var locked = {
                _sis : { locked : true }
            };
            var entity = (await ApiServer.put("/api/v1.1/entities/test_locked_entity/" + entityId)
                .send(locked).expect(200)).body;
            should.exist(entity);
            entity.str.should.eql("foo");
            entity.num.should.eql(20);
            entity._sis.locked.should.eql(true);
        });
        it("should fail to delete the entity", async function() {
            await ApiServer.del("/api/v1.1/entities/test_locked_entity/" + entityId)
                .expect(401);
        });
        it("should update the entity", async function() {
            var data = {
                str : "bar",
                num : 10
            };
            var entity = (await ApiServer.put("/api/v1.1/entities/test_locked_entity/" + entityId)
                .send(data).expect(200)).body;
            should.exist(entity);
            entity.str.should.eql("bar");
            entity.num.should.eql(10);
            entity._sis.locked.should.eql(true);
        });
        it("should unlock the entity", async function() {
            var data = {
                _sis : { locked : false }
            };
            var entity = (await ApiServer.put("/api/v1.1/entities/test_locked_entity/" + entityId)
                .send(data).expect(200)).body;
            should.exist(entity);
            entity.str.should.eql("bar");
            entity.num.should.eql(10);
            entity._sis.locked.should.eql(false);
        });
        it("should delete the entity", async function() {
            await ApiServer.del("/api/v1.1/entities/test_locked_entity/" + entityId)
                .expect(200);
        });
        after(async function() {
            await deleteSchema(schema);
        });
    });

    describe("remove empty arrays", function() {
        var schema = {
            name : "test_empty_arrays",
            _sis : { owner : ["sistest"] },
            definition : {
                name : "String",
                arr : ["String"],
                nested : {
                    str : "String",
                    arr : ["String"],
                    deeper : [{
                        field : "String",
                        arr : ["String"]
                    }]
                }
            }
        };
        var entityUrl = "/api/v1.1/entities/" + schema.name;
        var fooDoc = { name : "foo" };
        var barDoc = { name : "bar", nested : { str : "baz" } };
        before(async function() {
            await recreateSchema(schema);
        });
        after(async function() {
            await deleteSchema(schema);
        });

        it("should add foo and not receive empty arrays or objects", async function() {
            fooDoc = (await ApiServer.post(entityUrl).query({removeEmpty : true})
                .send(fooDoc).expect(201)).body;
            should.not.exist(fooDoc.arr);
            should.not.exist(fooDoc.nested);
        });

        it("should add bar and not receive empty arrays", async function() {
            barDoc = (await ApiServer.post(entityUrl).query({removeEmpty : true})
                .send(barDoc).expect(201)).body;
            should.not.exist(barDoc.arr);
            should.exist(barDoc.nested);
            should.not.exist(barDoc.nested.arr);
            should.not.exist(barDoc.nested.deeper);
        });

        it("should retrieve foo with empty arrays", async function() {
            var doc = (await ApiServer.get(entityUrl + "/" + fooDoc._id)
                .expect(200)).body;
            should.exist(doc.arr);
            should.exist(doc.nested);
            should.exist(doc.nested.arr);
            should.exist(doc.nested.deeper);
        });

        it("should update foo and show non empty arrays", async function() {
            var doc = (await ApiServer.put(entityUrl + "/" + fooDoc._id)
                .query({ removeEmpty : true })
                .send({ arr : ["str"] }).expect(200)).body;
            should.exist(doc.arr);
            should.not.exist(doc.nested);
        });
    });

    describe("SIS maintained meta fields", function() {
        var schema = {
            name : "test_sis_meta_entity",
            _sis : { owner : ["sistest"] },
            definition : { name : "String", num : "Number" }
        };
        var entityUrl = "/api/v1.1/entities/" + schema.name;
        var doc = null;
        before(async function() {
            await recreateSchema(schema);
            doc = (await ApiServer.post(entityUrl).send({ name : "meta", num : 0 })
                .expect(201)).body;
        });
        after(async function() {
            await deleteSchema(schema);
        });

        it("should not let an update set them", async function() {
            var update = { num : 1, _sis : { _created_by : "forged", _created_at : 1,
                                              _updated_by : "forged", _updated_at : 1 } };
            await ApiServer.put(entityUrl + "/" + doc._id).send(update).expect(200);
            var res = await ApiServer.get(entityUrl + "/" + doc._id).expect(200);
            var meta = res.body._sis;
            res.body.num.should.eql(1);
            meta._created_by.should.eql(doc._sis._created_by);
            meta._created_at.should.eql(doc._sis._created_at);
            meta._updated_by.should.eql(doc._sis._updated_by);
            meta._updated_at.should.be.aboveOrEqual(doc._sis._updated_at);
        });
    });

    describe("CAS operations", function() {

        var schema = {
            name : "test_cas_entity",
            _sis : { owner : ["sistest"] },
            definition : {
                name : "String",
                num : "Number",
                nested : { a : "String", b : "String" }
            }
        };
        var entityUrl = "/api/v1.1/entities/" + schema.name;
        var doc = { name : "CAStest", num : 0 };
        before(async function() {
            await recreateSchema(schema);
            // add the entity
            doc = (await ApiServer.post(entityUrl).send(doc).expect(201)).body;
        });
        after(async function() {
            await deleteSchema(schema);
        });

        it("should error on non object cas", async function() {
            await ApiServer.put(entityUrl + '/' + doc._id)
                .query({ cas : 1 }).send({ num : 1 })
                .expect(400);
        });

        it("should error on array cas", async function() {
            await ApiServer.put(entityUrl + '/' + doc._id)
                .query({ cas : [1,2,3] }).send({ num : 1 })
                .expect(400);
        });

        it("should error on empty cas", async function() {
            await ApiServer.put(entityUrl + '/' + doc._id)
                .query({ cas : "{}" }).send({ num : 1 })
                .expect(400);
        });

        it("should update with cas object", async function() {
            var res = await ApiServer.put(entityUrl + '/' + doc._id)
                .query({ cas : { num : doc.num } }).send({ num : 1 })
                .expect(200);
            should.exist(res.body.num);
            res.body.num.should.eql(1);
            doc = res.body;
        });

        it("should update with cas string", async function() {
            var res = await ApiServer.put(entityUrl + '/' + doc._id)
                .query({ cas : JSON.stringify({ num : doc.num }) }).send({ num : 2 })
                .expect(200);
            should.exist(res.body.num);
            res.body.num.should.eql(2);
            doc = res.body;
        });

        it("should succeed only once", async function() {
            var casOp = { num : doc.num };
            var NUM_QUERIES = 10;
            var nums = [];
            for (var i = 0; i < NUM_QUERIES; ++i) {
                // add 100 to ensure no repeats.
                nums.push(i + 100);
            }
            var responses = await Promise.all(nums.map(function(num) {
                return ApiServer.put(entityUrl + '/' + doc._id)
                    .query({ cas : casOp }).send({ num : num });
            }));
            var succeeded = responses.filter(function(res) { return res.statusCode == 200; });
            succeeded.length.should.eql(1);
            responses.filter(function(res) { return res.statusCode == 400; }).length.should.eql(NUM_QUERIES - 1);
            doc = succeeded[0].body;
            nums.should.containEql(doc.num);
        });

        it("should keep what the cas update does not change", async function() {
            var url = entityUrl + '/' + doc._id;
            var setup = { nested : { a : "a0", b : "b0" }, _sis : { tags : ["t0"], locked : true } };
            var before = (await ApiServer.put(url).send(setup).expect(200)).body;
            var update = { nested : { a : "a1" }, _sis : { tags : ["t1"] } };
            await ApiServer.put(url).query({ cas : { num : before.num } }).send(update)
                .expect(200);
            var after = (await ApiServer.get(url).expect(200)).body;
            after.nested.should.eql({ a : "a1", b : "b0" });
            after._sis.tags.should.eql(["t1"]);
            after._sis.locked.should.eql(true);
            after._sis._created_by.should.eql(before._sis._created_by);
            after._sis._created_at.should.eql(before._sis._created_at);
            after._sis._updated_by.should.eql(before._sis._updated_by);
            after._sis._updated_at.should.be.aboveOrEqual(before._sis._updated_at);
            // unlock it so the schema can be deleted
            await ApiServer.put(url).send({ _sis : { locked : false } }).expect(200);
        });

    });

    describe("Forced Mixed Object updates", function() {
        var schema = {
            name: "test_force_mixed",
            _sis: { owner: ["sistest"] },
            definition: {
                name: "String",
                mixed: "Mixed"
            }
        };

        var entity = {
            name: "Test Forced",
            mixed: {
                key1: "val1",
                key2: 2
            }
        };
        before(async function() {
            await recreateSchema(schema);
            entity = (await ApiServer.post("/api/v1.1/entities/test_force_mixed")
                .set("Content-Type", "application/json")
                .send(entity).expect(201)).body;
            should.exist(entity);
            should.exist(entity.mixed);
            should.exist(entity.mixed.key1);
            should.exist(entity.mixed.key2);
        });

        after(async function() {
            await deleteSchema(schema);
        });

        it("Should not remove key1 and key2, but set key3", async function() {
            var mixed = {
                key3: { force_mixed: "not set" }
            };
            var result = (await ApiServer.put("/api/v1.1/entities/test_force_mixed/" + entity._id)
                .set("Content-Type", "application/json")
                .send({ mixed : mixed })
                .expect(200)).body;
            delete entity._sis;
            delete result._sis;
            should.exist(result.mixed.key1);
            should.exist(result.mixed.key2);
            should.exist(result.mixed.key3);
            result.mixed.key3.should.eql(mixed.key3);
            entity = result;
        });

        it("Should remove key1, key2 and only set key3", async function() {
            entity.mixed = {
                key3: { force_mixed_set: true }
            };
            expectSameAs(await ApiServer.put("/api/v1.1/entities/test_force_mixed/" + entity._id)
                .set("Content-Type", "application/json")
                .query({forceMixed: true})
                .send({mixed : entity.mixed })
                .expect(200), entity);
        });
    });
});
