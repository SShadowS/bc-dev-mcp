codeunit 50928 "Acc Legacy Export"
{
    var
        Formatter: Codeunit "Acc Report Formatter";

    // Deliberately reached by no test: the "uncoverable" changed procedure.
    procedure ExportLine(ItemNo: Code[20]; Amount: Decimal): Text
    begin
        exit(ItemNo + ';' + Formatter.FormatAmount(Amount));
    end;
}
