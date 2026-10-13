codeunit 50982 "Sel Standard Rate" implements "Sel Shipping Rate"
{
    procedure Rate(Weight: Decimal): Decimal
    begin
        exit(10 + Weight * 0.5);
    end;
}
