codeunit 50931 "Acc Report Formatter"
{
    var
        Math: Codeunit "Acc Math";

    procedure FormatAmount(Amount: Decimal): Text
    begin
        exit(Format(Math.Round2(Amount), 0, '<Precision,2:2><Standard Format,0>'));
    end;
}
