codeunit 50911 "Acc Discount Rules"
{
    var
        Core: Codeunit "Acc Discount Core";
        Validation: Codeunit "Acc Discount Validation";
        Math: Codeunit "Acc Math";

    procedure ApplyDiscount(Amount: Decimal; DiscountPct: Decimal): Decimal
    begin
        Validation.ValidatePct(DiscountPct);
        exit(Amount - Math.Percent(Amount, DiscountPct));
    end;

    procedure CustomerPrice(Amount: Decimal; Rating: Integer): Decimal
    begin
        exit(ApplyDiscount(Amount, Core.CustomerDiscountPct(Rating)));
    end;
}
