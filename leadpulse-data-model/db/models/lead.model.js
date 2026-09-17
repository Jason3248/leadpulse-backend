'use strict';

module.exports = (sequelize, DataTypes) => {
  const Lead = sequelize.define(
    'Lead',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      firstName: { type: DataTypes.STRING(100), allowNull: false },
      lastName: { type: DataTypes.STRING(100), allowNull: true },
      // Globally unique — one identity record per real person, agency-wide,
      // regardless of how many Clients later target them.
      email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      phone: { type: DataTypes.STRING(30), allowNull: true },
      company: { type: DataTypes.STRING(255), allowNull: true },
      jobTitle: { type: DataTypes.STRING(150), allowNull: true },
      industry: { type: DataTypes.STRING(150), allowNull: true },
      source: { type: DataTypes.STRING(150), allowNull: true }
      // Consent (dnc / isUnsubscribed / isHardBounced) intentionally lives
      // on ClientLead, not here — those are facts about this person's
      // relationship with ONE Client, not about the person globally.
    },
    {
      tableName: 'leads',
      underscored: true,
      timestamps: true
    }
  );

  Lead.associate = (models) => {
    Lead.hasMany(models.ClientLead, { as: 'clientMappings', foreignKey: 'leadId' });
    Lead.hasMany(models.LeadListMembership, { as: 'memberships', foreignKey: 'leadId' });
    Lead.belongsToMany(models.LeadList, {
      through: models.LeadListMembership,
      as: 'leadLists',
      foreignKey: 'leadId',
      otherKey: 'leadListId'
    });
    Lead.hasMany(models.CampaignLead, { as: 'campaignParticipations', foreignKey: 'leadId' });
  };

  return Lead;
};
