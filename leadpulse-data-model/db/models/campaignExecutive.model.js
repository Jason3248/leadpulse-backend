'use strict';

module.exports = (sequelize, DataTypes) => {
  const CampaignExecutive = sequelize.define(
    'CampaignExecutive',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      campaignId: { type: DataTypes.UUID, allowNull: false },
      executiveUserId: { type: DataTypes.UUID, allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      unassignedAt: { type: DataTypes.DATE, allowNull: true }
    },
    {
      tableName: 'campaign_executives',
      underscored: true,
      timestamps: true,
      updatedAt: false
    }
  );

  CampaignExecutive.associate = (models) => {
    CampaignExecutive.belongsTo(models.Campaign, { as: 'campaign', foreignKey: 'campaignId' });
    CampaignExecutive.belongsTo(models.User, { as: 'executive', foreignKey: 'executiveUserId' });
  };

  return CampaignExecutive;
};
