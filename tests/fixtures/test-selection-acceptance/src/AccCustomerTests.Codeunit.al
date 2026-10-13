codeunit 50940 "Acc Customer Tests"
{
    Subtype = Test;

    [Test]
    procedure CreditLimitTopRating()
    var
        Core: Codeunit "Acc Customer Core";
    begin
        if Core.CreditLimitFor(1) <> 10000 then
            Error('CreditLimitFor(1) should be 10000');
    end;

    [Test]
    procedure CanOrderWithinLimit()
    var
        Rules: Codeunit "Acc Customer Rules";
    begin
        if not Rules.CanOrder(2, 4000) then
            Error('Rating 2 should be able to order 4000');
    end;

    [Test]
    procedure CannotOrderOverLimit()
    var
        Rules: Codeunit "Acc Customer Rules";
    begin
        if Rules.CanOrder(3, 1500) then
            Error('Rating 3 should not be able to order 1500');
    end;

    [Test]
    procedure BlockedRatingCannotOrder()
    var
        Rules: Codeunit "Acc Customer Rules";
    begin
        if Rules.CanOrder(4, 1) then
            Error('Rating 4 is blocked');
    end;

    [Test]
    procedure RemainingCreditNeverNegative()
    var
        Rules: Codeunit "Acc Customer Rules";
    begin
        if Rules.RemainingCredit(3, 5000) <> 0 then
            Error('RemainingCredit(3, 5000) should be 0');
    end;
}
