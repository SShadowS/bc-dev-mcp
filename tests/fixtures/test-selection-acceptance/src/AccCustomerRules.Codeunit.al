codeunit 50902 "Acc Customer Rules"
{
    var
        Core: Codeunit "Acc Customer Core";
        Validation: Codeunit "Acc Customer Validation";
        Math: Codeunit "Acc Math";

    procedure CanOrder(Rating: Integer; Amount: Decimal): Boolean
    begin
        Validation.ValidateRating(Rating);
        if Core.IsBlockedRating(Rating) then
            exit(false);
        exit(Amount <= Core.CreditLimitFor(Rating));
    end;

    procedure RemainingCredit(Rating: Integer; Used: Decimal): Decimal
    begin
        exit(Math.Clamp(Core.CreditLimitFor(Rating) - Used, 0, 999999));
    end;
}
