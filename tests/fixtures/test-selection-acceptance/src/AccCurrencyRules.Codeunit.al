codeunit 50930 "Acc Currency Rules"
{
    var
        Core: Codeunit "Acc Currency Core";
        Math: Codeunit "Acc Math";

    procedure Convert(Amount: Decimal; CurrencyCode: Code[10]): Decimal
    begin
        exit(Math.Round2(Amount * Core.ExchangeRate(CurrencyCode)));
    end;
}
