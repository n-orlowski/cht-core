const chai = require('chai');
const chaiExclude = require('chai-exclude');
const { chtDocs, RestorableRulesStateStore, noolsPartnerTemplate } = require('./mocks');
const memdownMedic = require('@medic/memdown');
const PouchDB = require('pouchdb');
PouchDB.plugin(require('pouchdb-adapter-memory'));
const sinon = require('sinon');
const rewire = require('rewire');

const pouchdbProvider = require('../src/pouchdb-provider');
const rulesEmitter = require('../src/rules-emitter');
const wireup = rewire('../src/provider-wireup');
const settingsDoc = require('../../../config/default/app_settings.json');
const { assert, expect } = chai;
chai.use(chaiExclude);

const rulesStateStore = RestorableRulesStateStore();
const NOW = 50000;

const reportConnectedByPlace = {
  _id: 'reportByPlace',
  type: 'data_record',
  form: 'form',
  place_id: 'patient',
  reported_date: 2000,
};
const headlessReport = {
  _id: 'headlessReport',
  type: 'data_record',
  form: 'form',
  patient_id: 'headless',
  reported_date: 1000,
};
const taskOwnedByChtContact = {
  _id: 'taskOwnedBy',
  type: 'task',
  owner: 'patient',
};
const taskRequestedByChtContact = {
  _id: 'taskRequestedBy',
  type: 'task',
  requester: 'patient',
};
const headlessTask = {
  _id: 'headlessTask',
  type: 'task',
  requester: 'headless',
  owner: 'headless',
};

const fixtures = [
  chtDocs.contact,

  chtDocs.pregnancyReport,
  headlessReport,
  reportConnectedByPlace,

  taskOwnedByChtContact,
  taskRequestedByChtContact,
  headlessTask,
];

describe('provider-wireup integration tests', () => {
  let provider;
  let db;
  beforeEach(async () => {
    sinon.useFakeTimers(NOW);
    sinon.stub(rulesStateStore, 'currentUser').returns({ _id: 'mock_user_id' });
    wireup.__set__('rulesStateStore', rulesStateStore);
   
    db = await memdownMedic('../..');
    await db.bulkDocs(fixtures);

    sinon.spy(db, 'put');
    sinon.spy(db, 'query');

    provider = pouchdbProvider(db);
  });
  afterEach(() => {
    rulesStateStore.restore();
    sinon.restore();
    rulesEmitter.shutdown();
  });

  describe('stateChangeCallback', () => {
    it('wireup of contactTaskState to pouch', async () => {
      sinon.spy(provider, 'stateChangeCallback');

      const userDoc = {};
      await wireup.initialize(provider, settingsDoc, userDoc);
      expect(db.put.args[0]).excludingEvery(['rulesConfigHash', 'targetState']).to.deep.eq([{
        _id: pouchdbProvider.RULES_STATE_DOCID,
        rulesStateStore: {
          contactState: {},
        },
      }]);

      await wireup.fetchTasksFor(provider, ['abc']);
      await provider.stateChangeCallback.returnValues[0];
      expect(db.put.args[db.put.callCount - 1]).excludingEvery(['rulesConfigHash', 'targetState']).excluding('_rev').to.deep.eq([{
        _id: pouchdbProvider.RULES_STATE_DOCID,
        rulesStateStore: {
          contactState: {
            'abc': {
              calculatedAt: NOW,
            },
          },
        },
      }]);
      expect(db.put.args[0][0].rulesStateStore.rulesConfigHash).to.eq(db.put.args[db.put.callCount - 1][0].rulesStateStore.rulesConfigHash);

      // simulate restarting the app. the database is the same, but the taskFetcher is uninitialized
      rulesEmitter.shutdown();
      rulesStateStore.__set__('state', undefined);

      const putCountBeforeInit = db.put.callCount;
      await wireup.initialize(provider, settingsDoc, userDoc);
      expect(db.put.callCount).to.eq(putCountBeforeInit);
      await wireup.fetchTasksFor(provider, ['abc']);
      expect(db.put.callCount).to.eq(putCountBeforeInit);
    });
  });

  it('latest schema rules are required when rules are provided', async () => {
    const rules = noolsPartnerTemplate('');
    const settings = { tasks: { rules }};
    try {
      await wireup.initialize(provider, settings, {});
      assert.fail('should throw');
    } catch (err) {
      expect(err.message).to.include('schema');
    }
  });

  describe('updateEmissionsFor', () => {
    it('empty array', async () => {
      sinon.stub(rulesStateStore, 'markDirty').resolves();
      await wireup.updateEmissionsFor(provider, []);
      expect(rulesStateStore.markDirty.args).to.deep.eq([[[]]]);
    });
 
    it('contact id', async () => {
      sinon.stub(rulesStateStore, 'markDirty').resolves();
      await wireup.updateEmissionsFor(provider, chtDocs.contact._id);
      expect(rulesStateStore.markDirty.args).to.deep.eq([[['patient']]]);
    });

    it('patient id', async () => {
      sinon.stub(rulesStateStore, 'markDirty').resolves();
      await wireup.updateEmissionsFor(provider, [chtDocs.contact.patient_id]);
      expect(rulesStateStore.markDirty.args).to.deep.eq([[['patient']]]);
    });

    it('unknown subject id still gets marked (headless scenario)', async () => {
      sinon.stub(rulesStateStore, 'markDirty').resolves();
      await wireup.updateEmissionsFor(provider, 'headless');
      expect(rulesStateStore.markDirty.args).to.deep.eq([[['headless']]]);
    });

    it('many', async () => {
      sinon.stub(rulesStateStore, 'markDirty').resolves();
      await wireup.updateEmissionsFor(provider, ['headless', 'patient', 'patient_id']);
      expect(rulesStateStore.markDirty.args).to.deep.eq([[['patient', 'headless', 'patient']]]); // dupes don't matter here
    });
  });

  describe('fetchTasksFor', () => {
    it('refresh headless', async () => {
      const rules = noolsPartnerTemplate('', { });
      const settings = { tasks: { rules }};
      sinon.stub(rulesEmitter, 'isLatestNoolsSchema').returns(true);
      sinon.spy(db, 'bulkDocs');
      await wireup.initialize(provider, settings, {});
   
      const refreshRulesEmissions = sinon.stub().resolves({
        targetEmissions: [],
        taskTransforms: [],
      });
      await wireup.__with__({ refreshRulesEmissions })(() => wireup.fetchTasksFor(provider, ['headless']));
      expect(refreshRulesEmissions.callCount).to.eq(1);
      expect(refreshRulesEmissions.args[0][0]).excludingEvery('_rev').to.deep.eq({
        contactDocs: [],
        reportDocs: [headlessReport],
        taskDocs: [headlessTask],
        userContactId: 'mock_user_id',
      });

      expect(db.bulkDocs.callCount).to.eq(1);
      expect(db.bulkDocs.args[0][0][0]).to.nested.include({
        _id: 'headlessTask',
        type: 'task',
        state: 'Cancelled', // invalid due to no emission data
      });
    });

    it('tasks tab includes headless reports and tasks', async () => {
      sinon.stub(rulesEmitter, 'isLatestNoolsSchema').returns(true);
      const rules = noolsPartnerTemplate('', { });
      const settings = { tasks: { rules }};
      await wireup.initialize(provider, settings, {});
   
      const refreshRulesEmissions = sinon.stub().resolves({
        targetEmissions: [],
        taskTransforms: [],
      });
      const withMockRefresher = wireup.__with__({ refreshRulesEmissions });
   
      await withMockRefresher(() => wireup.fetchTasksFor(provider));
      expect(refreshRulesEmissions.callCount).to.eq(1);
      expect(refreshRulesEmissions.args[0][0]).excludingEvery('_rev').to.deep.eq({
        contactDocs: [chtDocs.contact],
        reportDocs: [headlessReport, reportConnectedByPlace, chtDocs.pregnancyReport],
        taskDocs: [headlessTask, taskRequestedByChtContact],
        userContactId: 'mock_user_id',
      });

      expect(rulesStateStore.hasAllContacts()).to.be.true;
      await withMockRefresher(() => wireup.fetchTasksFor(provider));
      expect(refreshRulesEmissions.callCount).to.eq(2);
      expect(refreshRulesEmissions.args[1][0]).excludingEvery('_rev').to.deep.eq({});

      rulesStateStore.markDirty(['headless']);
      await withMockRefresher(() => wireup.fetchTasksFor(provider));
      expect(refreshRulesEmissions.callCount).to.eq(3);
      expect(refreshRulesEmissions.args[2][0]).excludingEvery('_rev').to.deep.eq({
        contactDocs: [],
        reportDocs: [headlessReport],
        taskDocs: [{
          _id: 'headlessTask',
          type: 'task',
          owner: 'headless',
          requester: 'headless',
          state: 'Cancelled',
          stateReason: 'invalid',
          stateHistory: [{
            state: 'Cancelled',
            timestamp: 50000,
          }]
        }],
        userContactId: 'mock_user_id',
      });
    });

    it('confirm no heavy lifting when fetch fresh contact (performance)', async () => {
      sinon.spy(rulesEmitter, 'getEmissionsFor');
      sinon.stub(rulesEmitter, 'isLatestNoolsSchema').returns(true);
      const rules = noolsPartnerTemplate('', { });
      const settings = { tasks: { rules }};
      await wireup.initialize(provider, settings, {});
      await rulesStateStore.markFresh(Date.now(), 'fresh');
   
      const actual = await wireup.fetchTasksFor(provider, ['fresh']);
      expect(actual).to.be.empty;
      expect(rulesEmitter.getEmissionsFor.callCount).to.eq(0);
      expect(db.query.callCount).to.eq(1);
    });

    /*
    This interaction with pouchdb is important as it is the difference of 30seconds vs 0.5second load times
    I've broken this a few times when refactoring, so adding this to ensure it stays
    */
    it('tasks tab does not provide a list of keys to tasks view (performance)', async () => {
      sinon.spy(rulesEmitter, 'getEmissionsFor');
      sinon.stub(rulesEmitter, 'isLatestNoolsSchema').returns(true);
      const rules = noolsPartnerTemplate('', { });
      const settings = { tasks: { rules }};
      await wireup.initialize(provider, settings, {});
      await rulesStateStore.markAllFresh(Date.now(), ['dirty']);
      await rulesStateStore.markDirty(Date.now(), ['dirty']);
      const actual = await wireup.fetchTasksFor(provider);
      expect(actual).to.be.empty;
      expect(rulesEmitter.getEmissionsFor.callCount).to.eq(0);
      expect(db.query.callCount).to.eq(3);
      expect(db.query.args[2][0]).to.eq('medic-client/tasks');
      expect(db.query.args[2][1]).to.not.have.property('keys');
    });
  });
});
