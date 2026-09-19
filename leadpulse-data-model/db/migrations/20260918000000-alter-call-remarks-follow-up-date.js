'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // We want to change follow_up_date from DATEONLY to TIMESTAMP WITH TIME ZONE
    await queryInterface.changeColumn('call_remarks', 'follow_up_date', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  down: async (queryInterface, Sequelize) => {
    // Revert back to DATEONLY
    await queryInterface.changeColumn('call_remarks', 'follow_up_date', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
  }
};
