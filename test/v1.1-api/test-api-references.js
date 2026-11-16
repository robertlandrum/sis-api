describe('@API @V1.1API - Entity References', function() {
    "use strict";

    var should = require('should');
    var mongoose = require('mongoose');

    var SIS = require("../../util/constants");

    var TestUtil = require('../fixtures/util');

    var ApiServer = new TestUtil.TestServer();

    before(async function() {
        await ApiServer.start();
        await ApiServer.becomeSuperUser();
    });

    after(async function() {
        await ApiServer.stop();
    });

    var addSchema = async function(schema) {
        await ApiServer.del('/api/v1.1/schemas/' + schema.name);
        await ApiServer.post('/api/v1.1/schemas').send(schema).expect(201);
    };

    var deleteSchema = function(name) {
        return ApiServer.del('/api/v1.1/schemas/' + name).expect(200);
    };

    // add num leaves to schemaName.  Resolves with their ids.
    var createLeaves = async function(schemaName, num) {
        var items = [];
        for (var i = 0; i < num; ++i) {
            items.push({
                name : "leaf_" + i,
                num : i
            });
        }
        var res = await ApiServer.post("/api/v1.1/entities/" + schemaName)
            .send(items).expect(200);
        res.body.success.length.should.eql(num);
        return res.body.success.map(function(l) {
            return l._id;
        });
    };

    // an object id that is not one of ids
    var getDneObjectId = function(ids) {
        var dneObjId = new mongoose.Types.ObjectId();
        while (ids.indexOf(String(dneObjId)) !== -1) {
            dneObjId = new mongoose.Types.ObjectId();
        }
        return dneObjId;
    };

    describe("Array references", function() {

        var schema_1 = {
            "name" : "ref_1",
            _sis : { "owner" : ["entity_test"] },
            "definition" : {
                "name" : "String"
            }
        };

        var schema_2 = {
            "name" : "ref_2",
            _sis : { "owner" : ["entity_test"] },
            "definition" : {
                "name" : "String",
                "refs" : [{ type : "ObjectId", ref : "ref_1"}]
            }
        };

        var schema_3 = {
            "name" : "ref_3",
            _sis : { "owner" : ["entity_test"] },
            "definition" : {
                "name" : "String"
            }
        };

        var schema_4 = {
            "name" : "ref_4",
            _sis : { "owner" : ["entity_test"] },
            "definition" : {
                "name" : "String",
                "ref" : { type : "ObjectId", ref : "ref_1" },
                "ref_multi" : [{ type : "ObjectId", ref : "ref_1" }]
            }
        };

        var schema_5 = {
            name : "ref_5",
            _sis : { "owner" : ["entity_test"] },
            definition : {
                name : "String",
                embedded_docs : [{
                    e_name : "String",
                    refs : [
                        { type : "ObjectId", ref : "ref_1" }
                    ]
                }]
            }
        };

        var schemas = [schema_1, schema_2, schema_3, schema_4, schema_5];
        var entities = {
            'ref_1' : [],
            'ref_3' : []
        };

        before(async function() {
            // setup the schemas
            await Promise.all(schemas.map(addSchema));
            await Promise.all(['foo', 'bar', 'baz', 'qux', 'quux'].map(async function(name) {
                for (var schemaName of ["ref_1", "ref_3"]) {
                    var res = await ApiServer.post("/api/v1.1/entities/" + schemaName)
                        .set("Content-Type", "application/json")
                        .query("populate=false")
                        .send({
                            "name" : name
                        })
                        .expect(201);
                    entities[schemaName].push(res.body);
                }
            }));
        });

        after(async function() {
            await Promise.all(schemas.map(function(s) { return deleteSchema(s.name); }));
        });


        it("ref_2 should have oid reference paths", async function() {
            var schema = (await ApiServer.get("/api/v1.1/schemas/ref_2").expect(200)).body;
            should.exist(schema._sis[SIS.FIELD_REFERENCES]);
            schema._sis[SIS.FIELD_REFERENCES].length.should.eql(1);
            schema._sis[SIS.FIELD_REFERENCES][0].should.eql('ref_1');
        });

        it("should fail to add a bad ref_2", async function() {
            var bad_refs = entities.ref_3;
            var ids = [bad_refs[0]._id, bad_refs[1]._id];
            var entity = {
                'name' : 'bad_ref_2',
                'refs' : ids
            };
            await ApiServer.post("/api/v1.1/entities/ref_2")
                .set("Content-Type", "application/json")
                .query("populate=false")
                .send(entity)
                .expect(400);
        });

        it("should add a good ref_2", async function() {
            var good_refs = entities.ref_1;
            var ids = [good_refs[0]._id, good_refs[1]._id];
            var entity = {
                'name' : 'good_ref_2',
                'refs' : ids
            };
            var id = (await ApiServer.post("/api/v1.1/entities/ref_2")
                .set("Content-Type", "application/json")
                .send(entity)
                .expect(201)).body._id;
            var result = (await ApiServer.get("/api/v1.1/entities/ref_2/" + id).expect(200)).body;
            should.exist(result.refs);
            should.exist(result.refs[0]);
            should.exist(result.refs[0].name);
        });

        it("should add a ref_2 with the refs it was read with", async function() {
            // a GET populates the refs - adding a copy must take them back
            var read = (await ApiServer.get("/api/v1.1/entities/ref_2").query({ q : { name : "good_ref_2" } })
                        .expect(200)).body[0];
            read.refs[0].should.have.property("name");
            var res = await ApiServer.post("/api/v1.1/entities/ref_2").query("populate=false")
                .send({ name : "copied_ref_2", refs : read.refs }).expect(201);
            res.body.refs.should.eql(read.refs.map(function(r) { return r._id; }));
        });

        it("should be able to update arrays of refs", async function() {
            var good_refs = entities.ref_1;
            var ids = [good_refs[0]._id, good_refs[1]._id];
            var entity = {
                'name' : 'good_ref_2_update',
                'refs' : []
            };
            var result = (await ApiServer.post("/api/v1.1/entities/ref_2")
                .set("Content-Type", "application/json")
                .send(entity)
                .expect(201)).body;
            // update the doc
            result.refs = ids;
            var r = (await ApiServer.put("/api/v1.1/entities/ref_2/" + result._id)
               .set("Content-Type", "application/json")
               .send(result)
               .expect(200)).body;
            should.exist(r.refs);
            should.exist(r.refs[0]);
            should.exist(r.refs[1]);
        });

        it("should be able to update a ref with null", async function() {
            var good_refs = entities.ref_1;
            var ids = [good_refs[0]._id, good_refs[1]._id];
            var entity = {
                'name' : 'good_ref_2_update',
                'refs' : ids
            };
            var result = (await ApiServer.post("/api/v1.1/entities/ref_2")
                .set("Content-Type", "application/json")
                .send(entity)
                .expect(201)).body;
            // update the doc
            result.refs = [null, ids[0]];
            var r = (await ApiServer.put("/api/v1.1/entities/ref_2/" + result._id)
               .set("Content-Type", "application/json")
               .send(result)
               .expect(200)).body;
            should.exist(r.refs);
            should.not.exist(r.refs[0]);
            should.exist(r.refs[1]);
        });

        var savedS5 = null;

        it("should add items in an array of embedded docs containing arrays of refs", async function() {
            var docs = entities.ref_1.map(function(r, idx) {
                return {
                    e_name : "d" + idx,
                    refs : [r._id]
                };
            });
            var s5Item = {
                name : "s5_test",
                embedded_docs : docs
            };
            savedS5 = (await ApiServer.post("/api/v1.1/entities/ref_5")
                .send(s5Item).expect(201)).body;
        });

        it("should update items in an array of embedded docs containing arrays of refs", async function() {
            var good_refs = entities.ref_1;
            savedS5.embedded_docs.forEach(function(ed, idx) {
                var ref_to_push = good_refs[(idx + 1) % good_refs.length];
                ed.refs.push(ref_to_push._id);
                // add a dupe
                ed.refs.push(ed.refs[0]);
            });
            await ApiServer.put("/api/v1.1/entities/ref_5/" + savedS5._id)
                .send(savedS5).expect(200);
        });
    });

    describe("Non existent schemas", function() {

        var schema1 = {
            name : "test_populate_schema_1",
            _sis : { owner : ["sistest"] },
            definition : {
                name : "String",
                other : { type : "ObjectId", ref : "test_populate_schema_2" }
            }
        };

        before(async function() {
            await addSchema(schema1);
            // add an entity
            await ApiServer.post("/api/v1.1/entities/test_populate_schema_1")
                .send({ name : "test"}).expect(201);
        });

        after(async function() {
            await deleteSchema(schema1.name);
        });

        it("should fetch entities without test_populate_schema_2", async function() {
            var res = (await ApiServer.get("/api/v1.1/entities/test_populate_schema_1")
                .expect(200)).body;
            res.should.be.instanceof(Array);
            res.length.should.eql(1);
        });

    });

    describe("Subdocs and arrays", function() {

        // need to test arrays of sub docs, arrays of object ids
        // and arrays of object ids -> sub array field
        var leaf_schema = {
            _sis : { "owner" : ["entity_test"] },
            "name" : "ref_leaf_schema",
            "definition" : {
                "name" : "String",
                "num" : "Number"
            }
        };

        var ancestor_schema = {
            _sis : { "owner" : ["entity_test"] },
            name : "ref_ancestor_schema",
            definition : {
                name : "String",
                num : "Number",
                leaves : [
                    { type : "ObjectId", ref : "ref_leaf_schema" }
                ],
                leaf_docs : [
                    {
                        doc_name : "String",
                        leaf : { type : "ObjectId", ref : "ref_leaf_schema" }
                    }
                ]
            }
        };

        var LEAVES = null;

        before(async function() {
            // delete/create all the schemas
            await Promise.all([leaf_schema, ancestor_schema].map(addSchema));
            LEAVES = await createLeaves(leaf_schema.name, 200);
        });

        var ANC_URL = "/api/v1.1/entities/" + ancestor_schema.name;

        it("Should fail to create the ancestor via leaves", async function() {
            var anc = {
                name : "anc_1",
                leaves : [getDneObjectId(LEAVES)]
            };
            await ApiServer.post(ANC_URL).send(anc).expect(400);
        });

        it("Should fail to create the ancestor via leaf_docs", async function() {
            var anc = {
                name : "anc_2",
                leaves : [LEAVES[0], LEAVES[1]],
                leaf_docs : [
                    {
                        doc_name : "exists",
                        leaf : LEAVES[2]
                    },
                    {
                        doc_name : "foo",
                        leaf : getDneObjectId(LEAVES)
                    }
                ]
            };
            await ApiServer.post(ANC_URL).send(anc).expect(400);
        });
    });

    describe("Bulk operations", function() {

        // need to test arrays of sub docs, arrays of object ids
        // and arrays of object ids -> sub array field
        var leaf_schema = {
            _sis : { "owner" : ["entity_test"] },
            "name" : "ref_leaf_schema",
            "definition" : {
                "name" : "String",
                "num" : "Number"
            }
        };

        var leaf_schema_2 = {
            _sis : { "owner" : ["entity_test"] },
            "name" : "ref_leaf_schema_2",
            "definition" : {
                "name" : "String",
                "num" : "Number"
            }
        };

        var ancestor_schema = {
            _sis : { "owner" : ["entity_test"] },
            name : "ref_ancestor_schema",
            definition : {
                name : "String",
                num : "Number",
                leaves : [
                    { type : "ObjectId", ref : "ref_leaf_schema" }
                ],
                leaf_docs : [
                    {
                        doc_name : "String",
                        leaf : { type : "ObjectId", ref : "ref_leaf_schema_2" }
                    }
                ]
            }
        };

        var LEAVES = null;
        var LEAVES_2 = null;

        before(async function() {
            // delete/create all the schemas
            await Promise.all([leaf_schema, leaf_schema_2, ancestor_schema].map(addSchema));
            var results = await Promise.all([
                createLeaves(leaf_schema.name, 200),
                createLeaves(leaf_schema_2.name, 200)
            ]);
            LEAVES = results[0];
            LEAVES_2 = results[1];
        });

        var getLeaves = function(coll, i, num, dne) {
            var result = [];
            for (var k = i; k < (i + num); ++k) {
                if (dne) {
                    result.push(getDneObjectId(coll));
                } else {
                    result.push(coll[k % coll.length]);
                }
            }
            return result;
        };

        // 1000 ancestors - the even ones refer to leaves that do not exist
        // if dneEvens
        var createAncestors = function(dneEvens) {
            var items = [];
            for (var i = 0; i < 1000; ++i) {
                var leaves = getLeaves(LEAVES, i, 2, dneEvens && i % 2 === 0);
                var leaves_2 = getLeaves(LEAVES_2, i, 2);
                items.push({
                    name : "bulk_anc_" + i,
                    leaves : [leaves[0], leaves[1]],
                    leaf_docs : [
                        {
                            doc_name : "doc_" + i,
                            leaf : leaves_2[0]
                        },
                        {
                            doc_name : "doc_" + (i + 1),
                            leaf : leaves_2[1]
                        }
                    ]
                });
            }
            return items;
        };

        var ANC_URL = "/api/v1.1/entities/" + ancestor_schema.name;

        it("Should work with bulks", async function() {
            var items = createAncestors(false);
            var result = (await ApiServer.post(ANC_URL).send(items).expect(200)).body;
            should.exist(result.success);
            result.success.length.should.eql(items.length);
        });

        it("Should return errors with bulks", async function() {
            var items = createAncestors(true);
            var result = (await ApiServer.post(ANC_URL).send(items).expect(200)).body;
            should.exist(result.success);
            result.success.length.should.eql(items.length / 2);
            result.errors.length.should.eql(items.length / 2);
        });


    });

});
