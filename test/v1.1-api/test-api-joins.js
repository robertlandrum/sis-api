describe('@API @V1.1API - Entity Join API', function() {
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

    describe("Get entities with joins", function() {
        var schemas = [];
        var numSchemas = 3;
        var numEnts = 50;
        var i, j;

        // create 3 schemas where join_schema_1 has a ref_0 to join_schema_0
        // and join_schema_2 has a ref_0 to join_schema_0 and ref_1 to join_schema_1
        for (i = 0; i < numSchemas; ++i) {
            var schema = {
                _sis : { "owner" : "entity_test" },
                "name" : "join_schema_" + i,
                "definition" : {
                    "name" : "String",
                    "num" : "Number"
                }
            };
            j = i - 1;
            while (j >= 0) {
                schema.definition['ref_' + j] = { type : "ObjectId", ref: "join_schema_" + j };
                --j;
            }
            schemas.push(schema);
        }

        // build entities
        // this becomes an array of array of entities that
        // get filled
        var entities = [];
        for (i = 0; i < numSchemas; i++) {
            var schema_ents = [];
            for (j = 0; j < numEnts; ++j) {
                schema_ents.push({
                    "name" : "join_ent_" + i + "_" + j,
                    "num" : ((i + 1) * 100) + j
                });
            }
            entities.push(schema_ents);
        }

        var addSchema = async function(schema) {
            await ApiServer.del('/api/v1.1/schemas/' + schema.name);
            await ApiServer.post('/api/v1.1/schemas').send(schema).expect(201);
        };

        before(async function() {
            // setup the schemas
            await Promise.all(schemas.map(addSchema));
            // join_ent_2_2 will have ref_1 = join_ent_1_2 and ref_0 = join_ent_0_2
            for (var i = 0; i < entities.length; ++i) {
                var entities2Add = entities[i];
                for (var j = i - 1; j >= 0; --j) {
                    var j_ents = entities[j];
                    for (var k = 0; k < j_ents.length; ++k) {
                        entities2Add[k]['ref_' + j] = j_ents[k]._id;
                    }
                }
                entities[i] = await Promise.all(entities2Add.map(async function(entity) {
                    var res = await ApiServer.post("/api/v1.1/entities/join_schema_" + i)
                        .set("Content-Type", "application/json")
                        .query("populate=false")
                        .send(entity)
                        .expect(201);
                    return res.body;
                }));
            }
        });

        after(async function() {
            await Promise.all(schemas.map(function(s) {
                return ApiServer.del('/api/v1.1/schemas/' + s.name).expect(200);
            }));
        });

        it("should fetch join_ent_1_2", async function() {
            var query = {
                q : { "ref_0.num" : 102 }
            };
            var res = await ApiServer.get("/api/v1.1/entities/join_schema_1")
                .query(query)
                .expect(200);
            res.statusCode.should.eql(200);
            should.exist(res.body);
            res.body.length.should.eql(1);
            var id = res.body[0]._id;
            entities[1][2]._id.should.eql(id);
        });

        it("should fetch join_ent_2_1", async function() {
            var query = {
                q :  { "ref_1.ref_0.num" : 101 }
            };
            var res = await ApiServer.get("/api/v1.1/entities/join_schema_2")
                .query(query)
                .expect(200);
            should.exist(res.body);
            res.statusCode.should.eql(200);
            res.body.length.should.eql(1);
            var id = res.body[0]._id;
            entities[2][1]._id.should.eql(id);
        });

        it("should fetch join_ent_2_5", async function() {
            var query = {
                q : {
                    "num" : { "$gt" : 302 },
                    "ref_1.num" : { "$gt" : 204 },
                    "ref_1.ref_0.num" : { "$lt" : 106 }
                }
            };
            var res = await ApiServer.get("/api/v1.1/entities/join_schema_2")
                .query(query)
                .expect(200);
            should.exist(res.body);
            res.statusCode.should.eql(200);
            res.body.length.should.eql(1);
            var id = res.body[0]._id;
            entities[2][5]._id.should.eql(id);
        });

        it("should fetch nothing 0", async function() {
            var query = {
                q : {
                    "num" : { "$gt" : 302 },
                    "ref_1.num" : { "$gt" : 204 },
                    "ref_1.ref_1.num" : { "$lt" : 106 }
                }
            };
            var res = await ApiServer.get("/api/v1.1/entities/join_schema_2")
                .query(query)
                .expect(200);
            should.exist(res.body);
            res.statusCode.should.eql(200);
            res.body.length.should.eql(0);
        });

        it("should fetch nothing 1", async function() {
            var query = {
                q : {
                    "num" : { "$gt" : 302 },
                    "ref_1.num" : { "$gt" : 204 },
                    "ref_1.ref_0." : { "$lt" : 106 }
                }
            };
            var res = await ApiServer.get("/api/v1.1/entities/join_schema_2")
                .query(query)
                .expect(200);
            should.exist(res.body);
            res.statusCode.should.eql(200);
            res.body.length.should.eql(0);
        });
    });

    describe("Joins for array refs", function() {

        // need to test arrays of sub docs, arrays of object ids
        // and arrays of object ids -> sub array field
        var leaf_schema = {
            _sis : { "owner" : ["entity_test"] },
            "name" : "join_leaf_schema",
            "definition" : {
                "name" : "String",
                "num" : "Number"
            }
        };

        var ancestor_schema = {
            _sis : { "owner" : ["entity_test"] },
            name : "join_ancestor_schema",
            definition : {
                name : "String",
                num : "Number",
                leaves : [
                    { type : "ObjectId", ref : "join_leaf_schema" }
                ],
                leaf_docs : [
                    {
                        doc_name : "String",
                        leaf : { type : "ObjectId", ref : "join_leaf_schema" }
                    }
                ]
            }
        };

        var top_schema = {
            _sis : { "owner" : ["entity_test"] },
            name : "join_top_schema",
            definition : {
                name : "String",
                num : "Number",
                ancs : [{ type : "ObjectId", ref : "join_ancestor_schema" }],
                anc_docs : [
                    {
                        rank : "Number" ,
                        anc : { type : "ObjectId", ref : "join_ancestor_schema" },
                    }
                ]
            }
        };

        // 24 total items
        var NUM_TOPS = 2;
        var NUM_ANC = 3;
        var NUM_LEAVES = 4;

        var TOPS = null;
        var ANCS = null;
        var LEAVES = null;

        // create leaves 0 - NUM_LEAVES
        var createLeaves = async function() {
            var totalLeaves = NUM_TOPS * NUM_ANC * NUM_LEAVES;
            var items = [];
            for (var i = 0; i < totalLeaves; ++i) {
                items.push({
                    name : "leaf_" + i,
                    num : i
                });
            }
            var res = await ApiServer.post("/api/v1.1/entities/" + leaf_schema.name)
                .send(items).expect(200);
            res.body.success.length.should.eql(totalLeaves);
            LEAVES = res.body.success;
            return LEAVES;
        };

        var createAncestors = async function(leaves) {
            var totalAncs = NUM_TOPS * NUM_ANC;
            var items = [];
            for (var i = 0; i < totalAncs; ++i) {
                items.push({
                    name : "anc_" + i,
                    num : i,
                    leaves : [],
                    leaf_docs : []
                });
            }
            leaves.forEach(function(leaf) {
                var idx = leaf.num;
                var anc = items[idx % items.length];
                anc.leaves.push(leaf._id);
                anc.leaf_docs.push({
                    doc_name : "ld_" + idx,
                    leaf : leaf._id
                });
            });
            var res = await ApiServer.post("/api/v1.1/entities/" + ancestor_schema.name)
                .send(items).expect(200);
            res.body.success.length.should.eql(totalAncs);
            ANCS = res.body.success;
            return ANCS;
        };

        var createTops = async function(ancs) {
            var totalTops = NUM_TOPS;
            var items = [];
            for (var i = 0; i < totalTops; ++i) {
                items.push({
                    name : "top_" + i,
                    num : i,
                    ancs : [],
                    anc_docs : []
                });
            }
            ancs.forEach(function(anc) {
                var idx = anc.num;
                var top = items[idx % items.length];
                top.ancs.push(anc._id);
                top.anc_docs.push({
                    rank : idx,
                    anc : anc._id
                });
            });
            var res = await ApiServer.post("/api/v1.1/entities/" + top_schema.name)
                .send(items).expect(200);
            res.body.success.length.should.eql(totalTops);
            TOPS = res.body.success;
            return TOPS;
        };

        before(async function() {
            // delete/create all the schemas
            await Promise.all([leaf_schema, ancestor_schema, top_schema].map(async function(schema) {
                var url = "/api/v1.1/schemas";
                await ApiServer.del(url + '/' + schema.name);
                await ApiServer.post(url).send(schema).expect(201);
            }));
            await createTops(await createAncestors(await createLeaves()));
        });

        // top 0 -> anc 0, 2, 4
        // top 1 -> anc 1, 3, 5
        // anc 0 -> leaf 0, 6, 12, 18
        // anc 1 -> leaf 1, 7, 13, 19
        // anc 2 -> leaf 2, 8, 14, 20
        // anc 3 -> leaf 3, 9, 15, 21
        // anc 4 -> leaf 4, 10, 16, 22
        // anc 5 -> leaf 5, 11, 17, 23

        it("Should fetch top 0 for anc 2 via ancs", async function() {
            var query = {
                "ancs.num" : 2
            };
            var r = (await ApiServer.get("/api/v1.1/entities/" + top_schema.name)
                .query({q : JSON.stringify(query) }).expect(200)).body;
            r.length.should.eql(1);
            r[0].num.should.eql(0);
        });

        it("Should fetch top 0 for anc 4 via anc_docs", async function() {
            var query = {
                "anc_docs.anc.num" : 4
            };
            var r = (await ApiServer.get("/api/v1.1/entities/" + top_schema.name)
                .query({q : JSON.stringify(query) }).expect(200)).body;
            r.length.should.eql(1);
            r[0].num.should.eql(0);
        });

        it("Should fetch top 1 for leaf 17 via leaves", async function() {
            var query = {
                "ancs.leaves.num" : 17
            };
            var r = (await ApiServer.get("/api/v1.1/entities/" + top_schema.name)
                .query({q : JSON.stringify(query) }).expect(200)).body;
            r.length.should.eql(1);
            r[0].num.should.eql(1);
        });

        it("Should fetch top 1 for leaf 17 via leaf_docs", async function() {
            var query = {
                "ancs.leaf_docs.leaf.num" : 17
            };
            var r = (await ApiServer.get("/api/v1.1/entities/" + top_schema.name)
                .query({q : JSON.stringify(query) }).expect(200)).body;
            r.length.should.eql(1);
            r[0].num.should.eql(1);
        });

        it("Should work with $or and fetch anc 0 and anc 1 via leaf docs", async function() {
            var query = {
                "$or" : [
                    { "leaf_docs.leaf.num" : 6 },
                    { "leaf_docs.leaf.num" : 13 }
                ]
            };
            var r = (await ApiServer.get("/api/v1.1/entities/" + ancestor_schema.name)
                .query({ q : JSON.stringify(query)}).expect(200)).body;
            r.length.should.eql(2);
            var nums = r.map(function(anc) {
                return anc.num;
            });
            nums.sort();
            nums[0].should.eql(0);
            nums[1].should.eql(1);
        });

        it("Should work with and normal fields $or and fetch anc 1 via leaf docs", async function() {
            var query = {
                // fetches anc 1 and anc 0 per previous test
                "$or" : [
                    { "leaf_docs.leaf.num" : 6 },
                    { "leaf_docs.leaf.num" : 13 }
                ],
                "num" : 1
            };
            var r = (await ApiServer.get("/api/v1.1/entities/" + ancestor_schema.name)
                .query({ q : JSON.stringify(query)}).expect(200)).body;
            r.length.should.eql(1);
            var nums = r.map(function(anc) {
                return anc.num;
            });
            nums.sort();
            nums[0].should.eql(1);
        });

        it("Should work with $nor and fetch anc 2+", async function() {
            var query = {
                // fetches anc 1 and anc 0 per previous test
                "$nor" : [
                    { "leaf_docs.leaf.num" : 6 },
                    { "leaf_docs.leaf.num" : 13 }
                ]
            };
            var r = (await ApiServer.get("/api/v1.1/entities/" + ancestor_schema.name)
                .query({ q : JSON.stringify(query)}).expect(200)).body;
            r.length.should.eql(4);
            var nums = r.map(function(anc) {
                return anc.num;
            });
            nums.sort();
            nums.should.eql([2,3,4,5]);
        });

    });



});
