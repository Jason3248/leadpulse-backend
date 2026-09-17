'use strict';

module.exports = (sequelize, DataTypes) => {
  const LeadList = sequelize.define(
    'LeadList',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      clientId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
      importedByUserId: { type: DataTypes.UUID, allowNull: false }
    },
    {
      tableName: 'lead_lists',
      underscored: true,
      timestamps: true
    }
  );

  LeadList.associate = (models) => {
    LeadList.belongsTo(models.Client, { as: 'client', foreignKey: 'clientId' });
    LeadList.belongsTo(models.User, { as: 'importedBy', foreignKey: 'importedByUserId' });
    LeadList.hasMany(models.LeadListMembership, { as: 'memberships', foreignKey: 'leadListId' });
    LeadList.belongsToMany(models.Lead, {
      through: models.LeadListMembership,
      as: 'leads',
      foreignKey: 'leadListId',
      otherKey: 'leadId'
    });
    LeadList.hasMany(models.Campaign, { as: 'campaigns', foreignKey: 'leadListId' });
    LeadList.hasMany(models.ImportJob, { as: 'importJobs', foreignKey: 'leadListId' });
  };

  return LeadList;
};
