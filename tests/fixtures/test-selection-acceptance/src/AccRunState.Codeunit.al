codeunit 50927 "Acc Run State"
{
    SingleInstance = true;

    var
        LastRecalcPoints: Decimal;

    procedure SetLastRecalcPoints(Points: Decimal)
    begin
        LastRecalcPoints := Points;
    end;

    procedure GetLastRecalcPoints(): Decimal
    begin
        exit(LastRecalcPoints);
    end;
}
