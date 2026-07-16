codeunit 50133 "Power Controls Tests"
{
    Subtype = Test;

    [Test]
    procedure ErrorAfterCaught()
    var
        Probe: Codeunit "Power Controls Probe";
    begin
        Probe.CaughtError(); // breakOnError:"unhandled" must NOT break here
        Probe.UncaughtError(1, 0); // ... and MUST break here
    end;

    [Test]
    procedure TempThenRealWrite()
    var
        Probe: Codeunit "Power Controls Probe";
    begin
        Probe.TempWrite(); // breakOnRecordWrite:"nonTemporary" must NOT break here
        Probe.RealWrite(); // ... and MUST break here
    end;

    [Test]
    procedure SqlThenError()
    var
        Probe: Codeunit "Power Controls Probe";
    begin
        Probe.RealWrite(); // guarantee at least one row and some SQL
        Probe.SqlActivityThenError();
    end;

    [Test]
    procedure BigStringBreak()
    var
        Probe: Codeunit "Power Controls Probe";
    begin
        Probe.BigStringThenError();
    end;
}
