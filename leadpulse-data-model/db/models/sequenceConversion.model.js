'use strict';

module.exports = (sequelize, DataTypes) => {
  const SequenceConversion = sequelize.define(
    'SequenceConversion',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      sequenceId: { type: DataTypes.UUID, allowNull: false },
      leadId: { type: DataTypes.UUID, allowNull: false },
      // Which step actually produced the conversion — for reporting only.
      // Billing never looks at this; it only counts rows.
      campaignId: { type: DataTypes.UUID, allowNull: false },
      channel: { type: DataTypes.ENUM('email', 'call'), allowNull: false },
      convertedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    },
    {
      tableName: 'sequence_conversions',
      underscored: true,
      timestamps: true,
      updatedAt: false
    }
  );

  SequenceConversion.associate = (models) => {
    SequenceConversion.belongsTo(models.Sequence, { as: 'sequence', foreignKey: 'sequenceId' });
    SequenceConversion.belongsTo(models.Lead, { as: 'lead', foreignKey: 'leadId' });
    SequenceConversion.belongsTo(models.Campaign, { as: 'campaign', foreignKey: 'campaignId' });
  };

  return SequenceConversion;
};
