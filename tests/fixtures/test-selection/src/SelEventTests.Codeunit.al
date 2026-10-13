codeunit 50986 "Sel Event Tests"
{
    Subtype = Test;

    // These tests reach "Sel Surcharge Subscriber" only through the OnAfterFinalizeAmount
    // integration event; none of them names the subscriber codeunit.
    [Test]
    procedure FinalizeSmallAmountAddsSurcharge()
    var
        Pricing: Codeunit "Sel Pricing";
    begin
        if Pricing.FinalizeAmount(40) <> 45 then
            Error('FinalizeAmount(40) should add a 5 surcharge');
    end;

    [Test]
    procedure FinalizeLargeAmountNoSurcharge()
    var
        Pricing: Codeunit "Sel Pricing";
    begin
        if Pricing.FinalizeAmount(150) <> 150 then
            Error('FinalizeAmount(150) should add no surcharge');
    end;

    [Test]
    procedure FinalizeAfterDiscount()
    var
        Pricing: Codeunit "Sel Pricing";
    begin
        if Pricing.FinalizeAmount(Pricing.ApplyDiscount(100, 50)) <> 55 then
            Error('FinalizeAmount(ApplyDiscount(100, 50)) should be 55');
    end;

    [Test]
    procedure CalcLineAmountRaisesNoEvent()
    var
        Pricing: Codeunit "Sel Pricing";
    begin
        if Pricing.CalcLineAmount(2, 20) <> 40 then
            Error('CalcLineAmount(2, 20) should be 40 with no surcharge');
    end;
}
