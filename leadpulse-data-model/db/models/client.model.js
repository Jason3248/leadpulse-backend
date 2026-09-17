'use strict';

module.exports = (sequelize, DataTypes) => {
  const Client = sequelize.define(
    'Client',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      managerId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      contactPerson: { type: DataTypes.STRING(255), allowNull: true },
      contactEmail: { type: DataTypes.STRING(255), allowNull: true },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
    },
    {
      tableName: 'clients',
      underscored: true,
      timestamps: true
    }
  );

  Client.associate = (models) => {
    Client.belongsTo(models.User, { as: 'manager', foreignKey: 'managerId' });
    Client.hasMany(models.User, { as: 'portalUsers', foreignKey: 'clientId' });
    Client.hasMany(models.LeadList, { as: 'leadLists', foreignKey: 'clientId' });
    Client.hasMany(models.ClientLead, { as: 'clientLeads', foreignKey: 'clientId' });
    Client.hasMany(models.Campaign, { as: 'campaigns', foreignKey: 'clientId' });
    Client.hasMany(models.Sequence, { as: 'sequences', foreignKey: 'clientId' });
    Client.hasMany(models.ImportJob, { as: 'importJobs', foreignKey: 'clientId' });
  };

  return Client;
};
