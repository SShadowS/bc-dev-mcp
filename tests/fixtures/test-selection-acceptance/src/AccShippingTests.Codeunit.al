codeunit 50945 "Acc Shipping Tests"
{
    Subtype = Test;

    [Test]
    procedure StandardFreight()
    var
        Core: Codeunit "Acc Shipping Core";
    begin
        if Core.Freight(10, false) <> 15 then
            Error('Standard freight for 10 should be 15');
    end;

    [Test]
    procedure ExpressFreight()
    var
        Core: Codeunit "Acc Shipping Core";
    begin
        if Core.Freight(10, true) <> 45 then
            Error('Express freight for 10 should be 45');
    end;

    [Test]
    procedure FreeAboveThreshold()
    var
        Rules: Codeunit "Acc Shipping Rules";
    begin
        if Rules.ShippingCharge(600, 10, false) <> 0 then
            Error('Orders of 600 ship free');
    end;

    [Test]
    procedure ChargedBelowThreshold()
    var
        Rules: Codeunit "Acc Shipping Rules";
    begin
        if Rules.ShippingCharge(100, 10, false) <> 15 then
            Error('Orders of 100 pay 15 freight');
    end;

    [Test]
    procedure ExpressNeverFree()
    var
        Rules: Codeunit "Acc Shipping Rules";
    begin
        if Rules.ShippingCharge(600, 10, true) <> 45 then
            Error('Express is never free');
    end;
}
