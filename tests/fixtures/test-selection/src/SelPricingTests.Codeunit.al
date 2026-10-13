codeunit 50985 "Sel Pricing Tests"
{
    Subtype = Test;

    [Test]
    procedure CalcLineAmountMultiplies()
    var
        Pricing: Codeunit "Sel Pricing";
    begin
        if Pricing.CalcLineAmount(3, 12.5) <> 37.5 then
            Error('CalcLineAmount(3, 12.5) should be 37.5');
    end;

    [Test]
    procedure CalcLineAmountZeroQuantity()
    var
        Pricing: Codeunit "Sel Pricing";
    begin
        if Pricing.CalcLineAmount(0, 99) <> 0 then
            Error('CalcLineAmount(0, 99) should be 0');
    end;

    [Test]
    procedure ApplyDiscountTenPercent()
    var
        Pricing: Codeunit "Sel Pricing";
    begin
        if Pricing.ApplyDiscount(200, 10) <> 180 then
            Error('ApplyDiscount(200, 10) should be 180');
    end;

    [Test]
    procedure RoundAmountHalfUp()
    var
        Pricing: Codeunit "Sel Pricing";
    begin
        if Pricing.RoundAmount(1.005) <> 1.01 then
            Error('RoundAmount(1.005) should be 1.01');
    end;
}
