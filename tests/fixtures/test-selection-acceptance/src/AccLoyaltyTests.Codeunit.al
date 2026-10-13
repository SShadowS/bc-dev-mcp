codeunit 50947 "Acc Loyalty Tests"
{
    Subtype = Test;

    [Test]
    procedure PointsPerTenSpent()
    var
        Core: Codeunit "Acc Loyalty Core";
    begin
        if Core.PointsFor(95) <> 9 then
            Error('PointsFor(95) should be 9');
    end;

    [Test]
    procedure BonusAboveThousand()
    var
        Core: Codeunit "Acc Loyalty Core";
    begin
        if Core.PointsFor(1000) <> 150 then
            Error('PointsFor(1000) should be 150 with the bonus');
    end;

    [Test]
    procedure SilverTier()
    var
        Rules: Codeunit "Acc Loyalty Rules";
    begin
        if Rules.Tier(150) <> 'Silver' then
            Error('150 points should be Silver');
    end;

    [Test]
    procedure GoldTier()
    var
        Rules: Codeunit "Acc Loyalty Rules";
    begin
        if Rules.Tier(500) <> 'Gold' then
            Error('500 points should be Gold');
    end;

    [Test]
    procedure NightlyRecalcDecays()
    var
        Rules: Codeunit "Acc Loyalty Rules";
    begin
        if Rules.RecalcNightly() <> 270 then
            Error('Nightly recalc of 2500 should give 270 points');
    end;
}
