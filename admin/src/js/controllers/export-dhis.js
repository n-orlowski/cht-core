const moment = require('moment');

angular.module('controllers').controller('ExportDhisCtrl',
  function (
    $scope,
    DB,
    Export,
    Settings
  ) {
    'use strict';
    'ngInject';

    const MONTHS_TO_SHOW = 6;

    Settings().then(settingsDoc => {
      $scope.dataSets = settingsDoc.dhisDataSets && Array.isArray(settingsDoc.dhisDataSets) && settingsDoc.dhisDataSets;
      $scope.selected.dataSet = $scope.dataSets[0] && $scope.dataSets[0].guid;
    });

    DB()
      .query('medic-client/contacts_by_type', { include_docs: true })
      .then(result => {
        $scope.places = result.rows
          .map(row => row.doc)
          .filter(contact => contact.dhis)
          .reduce((agg, curr) => {
            const orgUnitConfigs = Array.isArray(curr.dhis) ? curr.dhis : [curr.dhis];
            for (const orgUnitConfig of orgUnitConfigs) {
              const dataSet = orgUnitConfig.dataSet || null;
              if (!agg[dataSet]) {
                agg[dataSet] = [];
              }

              agg[dataSet].push({
                id: curr._id,
                name: curr.name,
              });
            }

            return agg;
          }, {});
      });

    $scope.periods = [...Array(MONTHS_TO_SHOW).keys()].map(val => {
      const period = moment().subtract(val, 'months');
      return {
        timestamp: period.valueOf().toString(),
        description: period.format('MMMM, YYYY'),
      };
    });
    $scope.selected = {};

    $scope.export = () => {
      const { dataSet, period, place } = $scope.selected;
      const filters = {
        dataSet,
        date: {
          from: period,
        },
      };

      if (place !== 'all') {
        filters.placeId = place;
      }

      Export('dhis', filters, {});
    };
  }
);