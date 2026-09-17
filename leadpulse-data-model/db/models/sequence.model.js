'use strict';

module.exports = (sequelize, DataTypes) => {
  const Sequence = sequelize.define(
    'Sequence',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      clientId: { type: DataTypes.UUID, allowNull: false },
      // The list the whole motion runs against. Every step targets the same
      // list, differing only in how it filters within it.
      leadListId: { type: DataTypes.UUID, allowNull: true },
      name: { type: DataTypes.STRING(255), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      // Pricing for the WHOLE motion. A client contracts for an outreach
      // effort, not for individual sends — so a lead who converts at any step
      // is billed exactly once for the sequence (see SequenceConversion).
      pricingModel: { type: DataTypes.ENUM('flat_retainer', 'cost_per_lead'), allowNull: true },
      retainerAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      ratePerLead: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
      createdByUserId: { type: DataTypes.UUID, allowNull: false }
    },
    {
      tableName: 'sequences',
      underscored: true,
      timestamps: true
    }
  );

  Sequence.associate = (models) => {
    Sequence.belongsTo(models.Client, { as: 'client', foreignKey: 'clientId' });
    Sequence.belongsTo(models.LeadList, { as: 'leadList', foreignKey: 'leadListId' });
    Sequence.belongsTo(models.User, { as: 'createdBy', foreignKey: 'createdByUserId' });
    Sequence.hasMany(models.Campaign, { as: 'campaigns', foreignKey: 'sequenceId' });
    Sequence.hasMany(models.SequenceConversion, { as: 'conversions', foreignKey: 'sequenceId' });
  };

  return Sequence;
};
