'use strict';

module.exports = (sequelize, DataTypes) => {
  const LeadListMembership = sequelize.define(
    'LeadListMembership',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      leadListId: { type: DataTypes.UUID, allowNull: false },
      leadId: { type: DataTypes.UUID, allowNull: false },
      // Per-list, not global — the same person can be Converted on one
      // list/product and New on another (see Lead model for the reasoning).
      status: {
        type: DataTypes.ENUM('New', 'Contacted', 'Qualified', 'Converted', 'Dead'),
        allowNull: false,
        defaultValue: 'New'
      },
      addedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    },
    {
      tableName: 'lead_list_memberships',
      underscored: true,
      timestamps: true,
      createdAt: false
    }
  );

  LeadListMembership.associate = (models) => {
    LeadListMembership.belongsTo(models.LeadList, { as: 'leadList', foreignKey: 'leadListId' });
    LeadListMembership.belongsTo(models.Lead, { as: 'lead', foreignKey: 'leadId' });
  };

  return LeadListMembership;
};
