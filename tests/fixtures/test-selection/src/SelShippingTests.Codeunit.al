codeunit 50987 "Sel Shipping Tests"
{
    Subtype = Test;

    [Test]
    procedure StandardRateDirect()
    var
        StandardRate: Codeunit "Sel Standard Rate";
    begin
        if StandardRate.Rate(10) <> 15 then
            Error('Standard Rate(10) should be 15');
    end;

    // The next three reach the rate codeunits only through interface dispatch; "Sel Express
    // Rate" is never named by any test.
    [Test]
    procedure ShippingCostStandardDispatch()
    var
        Pricing: Codeunit "Sel Pricing";
    begin
        if Pricing.ShippingCost(Enum::"Sel Carrier"::Standard, 4) <> 12 then
            Error('ShippingCost(Standard, 4) should be 12');
    end;

    [Test]
    procedure ShippingCostExpressDispatch()
    var
        Pricing: Codeunit "Sel Pricing";
    begin
        if Pricing.ShippingCost(Enum::"Sel Carrier"::Express, 4) <> 31 then
            Error('ShippingCost(Express, 4) should be 31');
    end;

    [Test]
    procedure ShippingCostExpressZeroWeight()
    var
        Pricing: Codeunit "Sel Pricing";
    begin
        if Pricing.ShippingCost(Enum::"Sel Carrier"::Express, 0) <> 25 then
            Error('ShippingCost(Express, 0) should be 25');
    end;
}
