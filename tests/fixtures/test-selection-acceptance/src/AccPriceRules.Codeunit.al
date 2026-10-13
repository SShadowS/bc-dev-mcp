codeunit 50908 "Acc Price Rules"
{
    var
        Core: Codeunit "Acc Price Core";
        Validation: Codeunit "Acc Price Validation";
        Math: Codeunit "Acc Math";

    procedure QuantityBreakPct(Quantity: Decimal): Decimal
    begin
        if Quantity >= 100 then
            exit(10);
        if Quantity >= 10 then
            exit(5);
        exit(0);
    end;

    procedure NetLineAmount(Quantity: Decimal; UnitPrice: Decimal): Decimal
    var
        Amount: Decimal;
    begin
        Validation.ValidateQuantity(Quantity);
        Amount := Core.LineAmount(Quantity, UnitPrice);
        exit(Amount - Math.Percent(Amount, QuantityBreakPct(Quantity)));
    end;
}
