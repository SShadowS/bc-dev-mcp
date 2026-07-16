codeunit 50132 "Power Controls Probe"
{
    // Live E2E targets for the debugger power-controls features: try-caught vs uncaught errors,
    // temporary vs real record writes, SQL activity before a break, and a large string watch.

    [TryFunction]
    procedure TryDivide(Numerator: Decimal; Denominator: Decimal)
    var
        Result: Decimal;
    begin
        Result := Numerator / Denominator; // caught by the try function when Denominator = 0
    end;

    procedure CaughtError()
    begin
        if TryDivide(1, 0) then;
    end;

    procedure UncaughtError(Numerator: Decimal; Denominator: Decimal)
    var
        Result: Decimal;
    begin
        Result := Numerator / Denominator; // runtime error when Denominator = 0
    end;

    procedure TempWrite()
    var
        TempLog: Record "Power Probe Log" temporary;
    begin
        TempLog."Entry No." := 1;
        TempLog.Note := 'temporary write';
        TempLog.Insert();
    end;

    procedure RealWrite()
    var
        Log: Record "Power Probe Log";
    begin
        if Log.FindLast() then;
        Log."Entry No." += 1;
        Log.Note := 'real write';
        Log.Insert();
    end;

    procedure SqlActivityThenError()
    var
        Log: Record "Power Probe Log";
        Count: Integer;
    begin
        if Log.FindSet() then
            repeat
                Count += 1;
            until Log.Next() = 0;
        UncaughtError(1, 0);
    end;

    procedure BigStringThenError()
    var
        BigString: Text;
    begin
        BigString := PadStr('', 2000, 'X');
        UncaughtError(1, 0); // break here and watch BigString
    end;
}
