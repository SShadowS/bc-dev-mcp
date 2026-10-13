codeunit 50941 "Acc Item Tests"
{
    Subtype = Test;

    [Test]
    procedure UnitCostBolt()
    var
        Core: Codeunit "Acc Item Core";
    begin
        if Core.UnitCost('BOLT') <> 2 then
            Error('UnitCost(BOLT) should be 2');
    end;

    [Test]
    procedure SalesPriceBolt()
    var
        Rules: Codeunit "Acc Item Rules";
    begin
        if Rules.SalesPrice('BOLT') <> 3 then
            Error('SalesPrice(BOLT) should be 3');
    end;

    [Test]
    procedure SalesPriceGear()
    var
        Rules: Codeunit "Acc Item Rules";
    begin
        if Rules.SalesPrice('GEAR') <> 50 then
            Error('SalesPrice(GEAR) should be 50');
    end;

    [Test]
    procedure GearWeight()
    var
        Core: Codeunit "Acc Item Core";
    begin
        if Core.Weight('GEAR') <> 2.5 then
            Error('Weight(GEAR) should be 2.5');
    end;

    [Test]
    procedure BlankItemNoFails()
    var
        Rules: Codeunit "Acc Item Rules";
    begin
        asserterror Rules.SalesPrice('');
    end;
}
