table 50134 "Power Probe Log"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "Entry No."; Integer) { }
        field(2; Note; Text[100]) { }
    }

    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
    }
}
