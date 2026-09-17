'use strict';

module.exports = (sequelize, DataTypes) => {
  const ClientLead = sequelize.define(
    'ClientLead',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      clientId: { type: DataTypes.UUID, allowNull: false },
      leadId: { type: DataTypes.UUID, allowNull: false },
      dnc: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      isUnsubscribed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      isHardBounced: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
    },
    {
      tableName: 'client_leads',
      underscored: true,
      timestamps: true
    }
  );

  ClientLead.associate = (models) => {
    ClientLead.belongsTo(models.Client, { as: 'client', foreignKey: 'clientId' });
    ClientLead.belongsTo(models.Lead, { as: 'lead', foreignKey: 'leadId' });
  };

  return ClientLead;
};
