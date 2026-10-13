codeunit 50943 "Acc Discount Tests"
{
    Subtype = Test;

    [Test]
    procedure TopRatingDiscount()
    var
        Core: Codeunit "Acc Discount Core";
    begin
        if Core.CustomerDiscountPct(1) <> 15 then
            Error('CustomerDiscountPct(1) should be 15');
    end;

    [Test]
    procedure ApplyTenPercent()
    var
        Rules: Codeunit "Acc Discount Rules";
    begin
        if Rules.ApplyDiscount(200, 10) <> 180 then
            Error('ApplyDiscount(200, 10) should be 180');
    end;

    [Test]
    procedure CustomerPriceRating2()
    var
        Rules: Codeunit "Acc Discount Rules";
    begin
        if Rules.CustomerPrice(100, 2) <> 90 then
            Error('CustomerPrice(100, 2) should be 90');
    end;

    [Test]
    procedure CustomerPriceRating5NoDiscount()
    var
        Rules: Codeunit "Acc Discount Rules";
    begin
        if Rules.CustomerPrice(100, 5) <> 100 then
            Error('CustomerPrice(100, 5) should be 100');
    end;

    [Test]
    procedure DiscountOver100Fails()
    var
        Rules: Codeunit "Acc Discount Rules";
    begin
        asserterror Rules.ApplyDiscount(1, 101);
    end;
}
