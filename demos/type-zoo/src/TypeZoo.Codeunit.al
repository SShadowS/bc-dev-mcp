codeunit 50140 "Type Zoo"
{
    // Demo codeunit for bc-dev-mcp's debugger variable-type coverage walkthrough
    // (demos/TYPE-ZOO.md). Declares and assigns one local of every major AL type,
    // then deliberately errors on the last line so a break-on-error debug session
    // pauses with every variable populated and in scope — no breakpoint
    // registration required (see demos/hello-bug for why that ordering matters).
    Subtype = Test;

    [Test]
    procedure ShowAllTypes()
    var
        // --- Simple types ---
        ZooInteger: Integer;
        ZooBigInteger: BigInteger;
        ZooDecimal: Decimal;
        ZooBoolean: Boolean;
        ZooByte: Byte;
        ZooChar: Char;
        ZooText: Text;
        ZooText50: Text[50];
        ZooCode20: Code[20];
        ZooDate: Date;
        ZooTime: Time;
        ZooDateTime: DateTime;
        ZooDuration: Duration;
        ZooGuid: Guid;
        ZooOption: Option Red,Green,Blue;
        ZooEnum: Enum "Type Zoo Color";
        // --- Complex / reference types ---
        Customer: Record Customer;
        RecRef: RecordRef;
        FldRef: FieldRef;
        KeyRf: KeyRef;
        // --- Collections ---
        ZooTextList: List of [Text];
        ZooDict: Dictionary of [Text, Integer];
        ZooIntArray: array[3] of Integer;
        // --- JSON ---
        ZooJsonObject: JsonObject;
        ZooJsonToken: JsonToken;
        ZooJsonValue: JsonValue;
        // --- Blob / streams ---
        TempBlob: Codeunit "Temp Blob";
        ZooInStream: InStream;
        ZooOutStream: OutStream;
        // --- Misc ---
        ZooVariant: Variant;
        ZooDateFormula: DateFormula;
    begin
        // --- Simple types ---
        ZooInteger := 42;
        ZooBigInteger := 2147483647; // Integer.MaxValue, widened below past it
        ZooBigInteger := ZooBigInteger * 1000; // 2147483647000 — exceeds Integer range
        ZooDecimal := 1234.5678;
        ZooBoolean := true;
        ZooByte := 255;
        ZooChar := 65; // 'A'
        ZooText := 'Zoo unbounded text value';
        ZooText50 := 'Zoo fifty-char text field example value';
        ZooCode20 := 'ZOOCODE001';
        ZooDate := DMY2Date(3, 7, 2026);
        ZooTime := 143045T;
        ZooDateTime := CreateDateTime(ZooDate, ZooTime);
        ZooDuration := ZooDateTime - CreateDateTime(DMY2Date(1, 7, 2026), 0T);
        ZooGuid := CreateGuid();
        ZooOption := ZooOption::Green;
        ZooEnum := ZooEnum::Blue;

        // --- Record / RecordRef / FieldRef / KeyRef ---
        Customer.Reset();
        if Customer.FindFirst() then;
        RecRef.GetTable(Customer);
        FldRef := RecRef.Field(1); // "No."
        KeyRf := RecRef.KeyIndex(1);

        // --- Collections ---
        ZooTextList.Add('Alpha');
        ZooTextList.Add('Bravo');
        ZooTextList.Add('Charlie');

        ZooDict.Add('one', 1);
        ZooDict.Add('two', 2);
        ZooDict.Add('three', 3);

        ZooIntArray[1] := 111;
        ZooIntArray[2] := 222;
        ZooIntArray[3] := 333;

        // --- JSON ---
        ZooJsonObject.Add('appName', 'Type Zoo');
        ZooJsonObject.Add('version', 1);
        ZooJsonObject.Get('appName', ZooJsonToken);
        ZooJsonValue := ZooJsonToken.AsValue();

        // --- Blob / streams ---
        TempBlob.CreateOutStream(ZooOutStream);
        ZooOutStream.WriteText('type zoo blob content');
        TempBlob.CreateInStream(ZooInStream);

        // --- Variant / DateFormula ---
        ZooVariant := Customer;
        Evaluate(ZooDateFormula, '<1M+15D>');

        Error('type zoo ready');
    end;
}
