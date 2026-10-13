codeunit 50900 "Acc Math"
{
    procedure Round2(Amount: Decimal): Decimal
    begin
        exit(Round(Amount, 0.01, '='));
    end;

    procedure Percent(Amount: Decimal; Pct: Decimal): Decimal
    begin
        exit(Round2(Amount * Pct / 100));
    end;

    procedure Clamp(Value: Decimal; MinValue: Decimal; MaxValue: Decimal): Decimal
    begin
        if Value < MinValue then
            exit(MinValue);
        if Value > MaxValue then
            exit(MaxValue);
        exit(Value);
    end;
}
